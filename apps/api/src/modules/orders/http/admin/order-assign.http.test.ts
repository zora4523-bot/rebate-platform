import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AdminOperationGuard } from '../../../platform/index.ts';
import type { AdminAssignDeps } from '../../application/admin-assign.ts';
import { AdminOrderAssignHttp, type AdminAssignBody } from './order-assign.http.ts';

const ORDER_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a01';
const USER_ID = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01';

function handler() {
  const run = vi.fn<AdminOperationGuard['run']>(async (_input, business) =>
    business({ adminId: USER_ID, appId: 'couli', isSuper: false, loginName: 'ops' }),
  );
  // Refusals checked before any database read: the deps are never touched.
  const assign = {} as AdminAssignDeps;
  return { run, http: new AdminOrderAssignHttp({ guard: { run }, assign }) };
}

function body(patch: Partial<AdminAssignBody> = {}): AdminAssignBody {
  return {
    user_id: USER_ID,
    expected_user_id: null,
    expected_locked: false,
    reason: '核实后指派',
    ...patch,
  };
}

async function refused(promise: Promise<unknown>): Promise<HttpException> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HttpException);
  return error as HttpException;
}

describe('AdminOrderAssignHttp', () => {
  it('[AC-B1-10f#27] runs under order.assign as a write and throws a 20001 envelope inside the guard', async () => {
    const { run, http } = handler();
    const request = { id: 'trace-1', ip: '192.0.2.1', headers: {} };
    const error = await refused(http.reassign(request, ORDER_ID, body({ reason: '核实' })));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toEqual({ request, permission: 'order.assign' });
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toMatchObject({
      code: 20001,
      data: { fields: ['reason'] },
      trace_id: 'trace-1',
    });
  });

  it('[AC-B1-10f#11] a non-UUID user_id or order_id is 20001 on that field', async () => {
    const { http } = handler();
    const request = { id: 'trace-2', headers: {} };
    const user = await refused(http.reassign(request, ORDER_ID, body({ user_id: 'nobody' })));
    expect(user.getResponse()).toMatchObject({ code: 20001, data: { fields: ['user_id'] } });
    const order = await refused(http.reassign(request, 'not-a-uuid', body()));
    expect(order.getResponse()).toMatchObject({ code: 20001, data: { fields: ['order_id'] } });
  });
});
