// Real rows and HTTP responses; @couli/db/testing is imported only by delivery.int.test.ts.
import { randomUUID } from 'node:crypto';
import type { KyselyPlugin, RootOperationNode } from 'kysely';
import { expect } from 'vitest';
import { appId, registerDevice, session, type Harness, type HttpApp } from '../config/kit.ts';
import { seedPage, success } from '../pages-read/kit.ts';

export const SECTIONS = [
  { id: 'public' },
  { id: 'any', condition: { has_parent: 'any', union_authorized: 'any', has_order: 'any' } },
  { id: 'login_yes', condition: { login: 'yes' } },
  { id: 'login_no', condition: { login: 'no' } },
  ...['has_parent', 'union_authorized', 'has_order'].flatMap((key) =>
    ['yes', 'no'].map((value) => ({ id: `${key}_${value}`, condition: { [key]: value } })),
  ),
  { id: 'both', condition: { union_authorized: 'yes', has_order: 'yes' } },
];
// F1-09k (test-change): SECTIONS minus has_parent_yes / has_parent_no, for the delivery cases whose
// logged-in expectations must hold both while has_parent is unknown (F1-09g, G3) and once F1-09j
// wires the real parent relation; has_parent itself is covered by #8 and pages-audience-parent/**.
export const SECTIONS_WITHOUT_PARENT = SECTIONS.filter(
  (section) => !section.id.startsWith('has_parent_'),
);

// F1-09k (test-change): `sections` is optional; the default keeps the original SECTIONS seed.
export async function audiencePage(h: Harness, sections: typeof SECTIONS = SECTIONS) {
  const id = appId();
  await seedPage(h, id, { versions: [{ number: 1, sections }] });
  const device = await registerDevice(h, id);
  const login = await session(h, id, device);
  return {
    id,
    userId: login.user.id,
    device,
    guest: { 'x-device-id': device.device_id },
    headers: { 'x-device-id': device.device_id, ...login.headers },
  };
}
export type Subject = Awaited<ReturnType<typeof audiencePage>>;

export async function visible(app: HttpApp, subject: Subject, guest = false) {
  const page = await success(app, subject.id, 'home', guest ? subject.guest : subject.headers);
  expect(page).toMatchObject({ page_key: 'home', version: 1, ttl_sec: 300 });
  return page.sections.map((section) => section['id']);
}

export type BindingStatus =
  'active' | 'pending_auth' | 'invalid' | 'released' | 'blocked' | 'unbound';
export async function binding(
  h: Harness,
  subject: { id: string; userId: string },
  platform: 'taobao' | 'pdd',
  status: BindingStatus,
) {
  const db = h.db.withSchema('app');
  const accountId = randomUUID();
  const bindingId = randomUUID();
  const now = h.deps.clock.now();
  await db
    .insertInto('union_accounts')
    .values({
      id: accountId,
      app_id: subject.id,
      platform,
      account_name: `audience-${accountId}`,
      status: 'active',
      auth_status: 'active',
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('union_bindings')
    .values({
      id: bindingId,
      app_id: subject.id,
      user_id: subject.userId,
      platform,
      union_account_id: accountId,
      status,
      relation_id: status === 'pending_auth' ? null : `relation-${bindingId}`,
      bound_at: status === 'pending_auth' ? null : now,
      released_at: status === 'released' ? now : null,
      cooldown_until: status === 'released' ? new Date(now.getTime() + 86_400_000) : null,
      blocked_reason: status === 'blocked' ? 'admin_disable' : null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return bindingId;
}

export async function order(
  h: Harness,
  subject: { id: string; userId: string },
  platformStatus: 'DEPOSIT_PAID' | 'PAID' | 'RECEIVED' | 'SETTLED' | 'INVALID',
  rebateStatus: 'UNATTRIBUTED' | 'ESTIMATED' | 'WAITING' | 'CREDITED' | 'VOID' | 'CLAWED_BACK',
) {
  const db = h.db.withSchema('app');
  const orderId = randomUUID();
  const subOrderId = `audience-${orderId}`;
  const attrAt = h.deps.clock.now();
  await db
    .insertInto('order_keys')
    .values({
      platform: 'taobao',
      sub_order_id: subOrderId,
      order_id: orderId,
      app_id: subject.id,
      attr_at: attrAt,
    })
    .execute();
  await db
    .insertInto('orders')
    .values({
      order_id: orderId,
      app_id: subject.id,
      platform: 'taobao',
      sub_order_id: subOrderId,
      raw_item_id: 'audience-item',
      user_id: subject.userId,
      buy_type: 'self',
      platform_status: platformStatus,
      rebate_status: rebateStatus,
      attr_at: attrAt,
    })
    .execute();
}

type FactTable = 'orders' | 'union_bindings';
// Observe/fail only audience SELECTs. All authentication, page and other queries stay real.
// This also proves app_id scoping: users.id is globally unique, so a cross-app duplicate
// user fixture would violate the actual PK/FK and could not catch a missing app predicate.
export function queryProbe(failing?: FactTable) {
  const queries: { table: FactTable; node: RootOperationNode }[] = [];
  const control: { failing: FactTable | null } = { failing: failing ?? null };
  const plugin: KyselyPlugin = {
    transformQuery({ node }) {
      if (node.kind === 'SelectQueryNode') {
        const from = JSON.stringify(node.from);
        for (const table of ['orders', 'union_bindings'] as const) {
          if (from?.includes(`"name":"${table}"`)) {
            queries.push({ table, node });
            if (table === control.failing) throw new Error(`audience read unavailable: ${table}`);
          }
        }
      }
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };
  return { plugin, queries, control };
}

export function hasEquality(node: unknown, column: string, value: string): boolean {
  if (node === null || typeof node !== 'object') return false;
  const fields = node as Record<string, unknown>;
  if (fields['kind'] === 'BinaryOperationNode') {
    const candidate = node as {
      operator?: { operator?: string };
      leftOperand?: { column?: { column?: { name?: string } } };
      rightOperand?: { value?: unknown };
    };
    if (
      candidate.operator?.operator === '=' &&
      candidate.leftOperand?.column?.column?.name === column &&
      candidate.rightOperand?.value === value
    )
      return true;
  }
  return Object.values(fields).some((child) => hasEquality(child, column, value));
}
