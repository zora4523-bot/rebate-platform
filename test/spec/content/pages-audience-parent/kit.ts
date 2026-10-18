// F1-09j: isolated real rows; database lifecycle belongs only to the integration test.
import type { KyselyPlugin, RootOperationNode } from 'kysely';
import { expect } from 'vitest';
import { seedUser } from '../../identity/request-context/db-kit.ts';
import { appId, registerDevice, session, type Harness, type HttpApp } from '../config/kit.ts';
import { seedPage, success } from '../pages-read/kit.ts';

export const SECTIONS = [
  { id: 'public' },
  { id: 'any', condition: { has_parent: 'any' } },
  { id: 'has_parent_yes', condition: { has_parent: 'yes' } },
  { id: 'has_parent_no', condition: { has_parent: 'no' } },
  { id: 'union_yes', condition: { union_authorized: 'yes' } },
  { id: 'union_no', condition: { union_authorized: 'no' } },
  { id: 'order_yes', condition: { has_order: 'yes' } },
  { id: 'order_no', condition: { has_order: 'no' } },
  { id: 'both', condition: { has_parent: 'yes', union_authorized: 'yes' } },
];

export async function audiencePage(h: Harness) {
  const id = appId();
  await seedPage(h, id, { versions: [{ number: 1, sections: SECTIONS }] });
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

export async function visible(app: HttpApp, subject: Subject, guest = false, key = 'home') {
  const page = await success(app, subject.id, key, guest ? subject.guest : subject.headers);
  expect(page).toMatchObject({ page_key: key, version: 1, ttl_sec: 300 });
  return page.sections.map((section) => section['id']);
}

export async function bindParent(h: Harness, subject: { id: string; userId: string }) {
  const parent = await seedUser(h.db, subject.id);
  await h.db
    .withSchema('app')
    .updateTable('users')
    .set({
      parent_id: parent.id,
      parent_bind_source: 'register',
      parent_bound_at: h.deps.clock.now(),
    })
    .where('app_id', '=', subject.id)
    .where('id', '=', subject.userId)
    .execute();
}

type Fact = 'parent' | 'union' | 'order';

// Authentication and page/config queries stay real. Fail only the parent projection, so an
// HTTP 200 cannot accidentally come from bypassing authentication or replacing the page service.
export function queryProbe() {
  const queries: { fact: Fact; node: RootOperationNode }[] = [];
  const control = { failParent: false };
  const plugin: KyselyPlugin = {
    transformQuery({ node }) {
      if (node.kind === 'SelectQueryNode') {
        const from = JSON.stringify(node.from);
        const selected = JSON.stringify(node.selections);
        const fact =
          from?.includes('"name":"users"') && selected?.includes('"name":"parent_id"')
            ? 'parent'
            : from?.includes('"name":"union_bindings"')
              ? 'union'
              : from?.includes('"name":"orders"')
                ? 'order'
                : null;
        if (fact !== null) {
          queries.push({ fact, node });
          if (fact === 'parent' && control.failParent) {
            throw new Error('synthetic parent read unavailable');
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
