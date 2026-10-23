import { randomUUID } from 'node:crypto';
import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { admin_permission } from '../../../../packages/contracts-ts/src/index.ts';
import { grant, seed } from '../accounts/kit.ts';
import {
  bodyOf,
  error,
  harness,
  PATHS,
  setup,
  signInAgain,
  STEP_UP_OPERATIONS,
  TARGET_OPERATIONS,
  type Operation,
} from './kit.ts';

// Who may call the six operations and with which step-up (contract x-auth super; totp tier on all
// but the rename). Before the implementation the routes are not registered: every request fails
// its first status assertion.
const h = harness(createTestDatabase, acquireTestRedis);

it.each(Object.keys(PATHS) as Operation[])(
  '[AC-B1-34h#8] 普通账号即使勾选全部权限并持有效 step-up 令牌，%s 也返回 10403 且什么都不变',
  async (operation) => {
    const f = await setup(h);
    const ordinary = await f.target();
    await grant(h, ordinary, f.actor, [...admin_permission]);
    const session = await signInAgain(f, ordinary);
    const step = await f.issue(ordinary, session.admin_token);
    const victim = await f.eligible(operation);
    const body = bodyOf(operation);
    const before = await f.snapshot();
    await error(
      await f.send(operation, {
        token: session.admin_token,
        step,
        ...(victim === undefined ? {} : { id: victim.id }),
        ...(body === undefined ? {} : { body }),
      }),
      operation,
      10403,
      { reason: 'admin_permission_denied' },
    );
    expect(await f.snapshot()).toEqual(before);
  },
);

it.each(STEP_UP_OPERATIONS)(
  '[AC-B1-34h#9] 超管不带 step-up 令牌调用 %s 返回 10003 tier=totp，什么都不变',
  async (operation) => {
    const f = await setup(h);
    const victim = await f.eligible(operation);
    const body = bodyOf(operation);
    const before = await f.snapshot();
    await error(
      await f.send(operation, {
        token: f.token,
        ...(victim === undefined ? {} : { id: victim.id }),
        ...(body === undefined ? {} : { body }),
      }),
      operation,
      10003,
      { tier: 'totp' },
    );
    expect(await f.snapshot()).toEqual(before);
  },
);

const UNKNOWN_KINDS = ['unknown', 'malformed', 'other-app'] as const;
it.each(
  TARGET_OPERATIONS.flatMap((operation) => UNKNOWN_KINDS.map((kind) => [operation, kind] as const)),
)(
  '[AC-B1-34h#10] %s 的 admin_id 不存在、不合法或属于其他 app（%s）返回 20001 admin_id',
  async (operation, kind) => {
    const f = await setup(h);
    const foreign =
      kind === 'other-app'
        ? await seed(h, `w_${randomUUID().replaceAll('-', '').slice(0, 24)}`, {
            status: operation === 'enable' ? 'disabled' : 'active',
          })
        : undefined;
    const id = foreign?.id ?? (kind === 'unknown' ? randomUUID() : 'not-a-uuid');
    const step = operation === 'rename' ? undefined : await f.issue();
    const body = bodyOf(operation);
    const foreignBefore = foreign === undefined ? undefined : await f.row(foreign.id);
    const before = await f.snapshot();
    await error(
      await f.send(operation, {
        token: f.token,
        id,
        ...(step === undefined ? {} : { step }),
        ...(body === undefined ? {} : { body }),
      }),
      operation,
      20001,
      { fields: ['admin_id'] },
    );
    expect(await f.snapshot()).toEqual(before);
    if (foreign !== undefined) expect(await f.row(foreign.id)).toEqual(foreignBefore);
  },
);
