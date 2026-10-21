import type { Schema } from '@couli/contracts-ts';
import { HttpException } from '@nestjs/common';
import { expect, it } from 'vitest';
import {
  AdminOperationGuard,
  type AdminActor,
  type AdminOperationInput,
  type AdminOperationResponse,
} from '../../../platform/index.ts';
import { AdminClaims, AdminClaimsFieldsError } from '../../application/admin-claims.ts';
import { AdminClaimsController } from './claims.controller.ts';

const APP = 'claims_unit';
const USER = '019c0000-0000-7000-8000-000000000001';
const CLAIM = '019c0000-0000-7000-8000-0000000000c1';

class RecordingGuard extends AdminOperationGuard {
  readonly inputs: AdminOperationInput[] = [];
  override async run(
    input: AdminOperationInput,
    business: (actor: AdminActor) => Promise<AdminOperationResponse>,
  ): Promise<AdminOperationResponse> {
    this.inputs.push(input);
    return business({ adminId: 'a', appId: APP, isSuper: false, loginName: 'a' });
  }
}

class StubClaims extends AdminClaims {
  readonly seen: unknown[] = [];
  override async list(appId: string, query: object): Promise<Schema<'AdminClaimPage'>> {
    this.seen.push({ appId, query });
    if ('q' in query) throw new AdminClaimsFieldsError(['q']);
    return {
      items: [],
      page: 1,
      page_size: 20,
      total: 0,
      counts: {
        submitted: 0,
        auto_matched: 0,
        manual_review: 0,
        approved: 0,
        rejected: 0,
        cancelled: 0,
      },
    };
  }
  override async detail(
    appId: string,
    claimId: string,
    userId: string | undefined,
  ): Promise<Schema<'AdminClaimDetail'>> {
    this.seen.push({ appId, claimId, userId });
    throw new AdminClaimsFieldsError(['claim_id']);
  }
}

function reply() {
  const headers: Record<string, string> = {};
  return {
    headers,
    header(name: string, value: string) {
      headers[name] = value;
    },
  };
}

it('[AC-B1-10j#3] 无 user_id 只认 order.claim；带 user_id 认 order.claim 或 user.lookup；只读、no-store', async () => {
  const guard = new RecordingGuard();
  const claims = new StubClaims();
  const controller = new AdminClaimsController(guard, claims);
  const request = { id: 'trace-1' } as never;
  const r = reply();
  const page = await controller.list(request, {}, r);
  expect(page).toMatchObject({ code: 0, msg: '', trace_id: 'trace-1', data: { total: 0 } });
  expect(r.headers['Cache-Control']).toBe('no-store');
  await controller.list(request, { user_id: USER }, reply());
  expect(guard.inputs.map((i) => [i.permission, i.readOnly])).toEqual([
    ['order.claim', true],
    [['order.claim', 'user.lookup'], true],
  ]);
  expect(claims.seen[1]).toEqual({ appId: APP, query: { user_id: USER } });
});

it('[AC-B1-10j#5] 参数拒绝转成 20001 data.fields，详情把 user_id 交给用例', async () => {
  const guard = new RecordingGuard();
  const claims = new StubClaims();
  const controller = new AdminClaimsController(guard, claims);
  const request = { id: 'trace-2' } as never;
  const refused = await controller.list(request, { q: ' ' }, reply()).catch((e: unknown) => e);
  expect(refused).toBeInstanceOf(HttpException);
  expect((refused as HttpException).getStatus()).toBe(400);
  expect((refused as HttpException).getResponse()).toMatchObject({
    code: 20001,
    data: { fields: ['q'] },
    trace_id: 'trace-2',
  });
  const r = reply();
  const unknown = await controller
    .detail(request, CLAIM, { user_id: USER }, r)
    .catch((e: unknown) => e);
  expect((unknown as HttpException).getResponse()).toMatchObject({
    code: 20001,
    data: { fields: ['claim_id'] },
  });
  expect(r.headers['Cache-Control']).toBe('no-store');
  expect(claims.seen.at(-1)).toEqual({ appId: APP, claimId: CLAIM, userId: USER });
  expect(guard.inputs.at(-1)?.permission).toEqual(['order.claim', 'user.lookup']);
});
