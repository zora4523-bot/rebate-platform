// 不连库的常量与纯函数（BR-ATTR-31、BR-ATTR-20 ③；契约 adminReassignOrder）。连库的夹具在 db-kit.ts，
// 数据库生命周期只在 *.int.test.ts 管理。期望值按契约与 08 手写，不取自实现。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { DB } from '@couli/db';
import type { Insertable } from 'kysely';
import { expect, vi } from 'vitest';
import type { AdminAssignAuditAction } from '../../../../apps/api/src/modules/orders/application/admin-assign.ts';
import type {
  AdminActor,
  AdminOperationGuard,
  AdminOperationInput,
} from '../../../../apps/api/src/modules/platform/http/admin-guard.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';

/** 契约示例里的指派原因（≥5 字）。 */
export const REASON = '用户提供购买截图，核实后指派';
export const IP = '192.0.2.41';
export const ADMIN_NAME = '测试运营';
export const AUDIT_ACTION: AdminAssignAuditAction = 'order_assign';
/** 20902 data.resource=order_attribution：已归属，或 locked 与 expected_locked 不符。 */
export const CONFLICT = { code: 20902, data: { resource: 'order_attribution' } } as const;
export const fieldsError = (field: string) => ({ code: 20001, data: { fields: [field] } });
export type TargetRefusal = 'target_banned' | 'target_deleting' | 'target_deleted';
export const targetRefused = (reason: TargetRefusal) => ({
  code: 20001,
  data: { fields: ['user_id'], reason },
});
/** The one totp step-up token the fake guard accepts (low-entropy test value). */
export const STEP_UP = 'step-up-plain-plain-plain';
/** specs/permissions.yaml step_up_tier of the points used here. */
const TIERS: Readonly<Record<string, 'totp' | null>> = {
  'order.assign': 'totp',
  'order.view': null,
  'order.claim': null,
};

/** BR-ATTR-16：未归因池的订单（user_id、user_basis 为空，locked=false）。 */
export const UNATTRIBUTED = {
  user_id: null,
  user_basis: null,
  locked: false,
  rebate_status: 'UNATTRIBUTED',
} satisfies Partial<Insertable<DB['orders']>>;

/**
 * The guard: the account holds `held.keys`; a point outside them is 10403; a write under a totp
 * point needs X-Step-Up-Token = STEP_UP, else 10003 (tier totp); then the business callback runs.
 * `outcomes` records how each business callback settled (a refusal must be thrown through it).
 */
export function fakeGuard(actor: AdminActor) {
  const held: { keys: readonly string[] } = { keys: ['order.view', 'order.assign'] };
  const calls: AdminOperationInput[] = [];
  const outcomes: ({ ok: true; code: number } | { ok: false; error: unknown })[] = [];
  const run = vi.fn<AdminOperationGuard['run']>(async (input, business) => {
    calls.push(input);
    const request = input.request as {
      id: string;
      headers: Record<string, string | string[] | undefined>;
    };
    const keys = typeof input.permission === 'string' ? [input.permission] : [...input.permission];
    if (!keys.some((key) => held.keys.includes(key))) {
      throw new GuardRefusal(403, {
        code: 10403,
        msg: '当前账号没有这项操作的权限，请联系超级管理员开通',
        data: { reason: 'admin_permission_denied' },
        trace_id: request.id,
      });
    }
    const totp = keys.some((key) => TIERS[key] === 'totp');
    if (input.readOnly !== true && totp && request.headers['x-step-up-token'] !== STEP_UP) {
      throw new GuardRefusal(403, {
        code: 10003,
        msg: '这项操作需要二次验证，请输入动态码',
        data: { tier: 'totp' },
        trace_id: request.id,
      });
    }
    try {
      const answer = await business(actor);
      outcomes.push({ ok: true, code: answer.body.code });
      return answer;
    } catch (error) {
      outcomes.push({ ok: false, error });
      throw error;
    }
  });
  return { guard: { run }, held, calls, outcomes };
}

/** A guard rejection shaped like Nest's HttpException (getStatus / getResponse). */
export class GuardRefusal extends Error {
  readonly status: number;
  readonly body: object;
  constructor(status: number, body: object) {
    super('guard refusal');
    this.status = status;
    this.body = body;
  }
  getStatus(): number {
    return this.status;
  }
  getResponse(): object {
    return this.body;
  }
}

/** The HTTP status and body of an error envelope thrown by the handler (HttpException shape). */
export function envelopeOf(error: unknown): { status: number; body: Record<string, unknown> } {
  const shaped = error as { getStatus?: unknown; getResponse?: unknown };
  expect(typeof shaped.getStatus, 'an HttpException-shaped refusal').toBe('function');
  expect(typeof shaped.getResponse, 'an HttpException-shaped refusal').toBe('function');
  const status = (shaped.getStatus as () => number).call(error);
  const body = (shaped.getResponse as () => Record<string, unknown>).call(error);
  return { status, body };
}

const apiRequire = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));

interface Document {
  components: { schemas: Record<string, JsonSchema> };
}
let document: Promise<Document> | undefined;
function contract(): Promise<Document> {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(path: string, options: object): Promise<Document>;
  };
  document ??= parser.dereference(
    fileURLToPath(new URL('../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
  return document;
}

/** `value` (as JSON) passes the contract schema `name` of components.schemas. */
export async function conforms(value: unknown, name: string): Promise<void> {
  const schema = (await contract()).components.schemas[name];
  expect(schema, `contracts/openapi.yaml components.schemas.${name}`).toBeDefined();
  const check = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  const json: unknown = JSON.parse(JSON.stringify(value));
  expect(check(json), JSON.stringify(check.errors)).toBe(true);
}
