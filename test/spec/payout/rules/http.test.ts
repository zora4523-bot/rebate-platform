import { afterEach, expect, it, vi } from 'vitest';
import { contractAuthOf } from '../../../../apps/api/src/modules/platform/index.ts';
import { actor } from './fixtures.ts';
import { assertContract, contract, httpFixture, success } from './http-kit.ts';

let f: Awaited<ReturnType<typeof httpFixture>> | undefined;
afterEach(async () => {
  try {
    await f?.close();
  } finally {
    f = undefined;
    vi.restoreAllMocks();
  }
});

it('[AC-B2-05c#70] api 真正装配且只注册一次 rules；移除 planned 并生成 login 路由', async () => {
  f = await httpFixture();
  expect(f.routes.filter((r) => r === 'GET /v1/withdrawals/rules')).toHaveLength(1);
  const operation = (await contract()).paths['/v1/withdrawals/rules']?.['get'];
  expect(operation).toMatchObject({
    operationId: 'getWithdrawRules',
    'x-auth': 'login',
    'x-signed': false,
    'x-idempotent': false,
  });
  expect(operation).not.toHaveProperty('x-implementation');
  expect(contractAuthOf('GET', '/v1/withdrawals/rules')).toBe('login');
  expect(f.app.getHttpServer().listening).toBe(false);
});

it('[AC-B2-05c#71] rules 正常响应过契约，无签名/幂等键/step-up 且旧版本仍可读取', async () => {
  f = await httpFixture();
  const response = await f.request();
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    code: 0,
    msg: '',
    data: success,
    trace_id: '01920000-0000-7000-8000-000000000059',
  });
  await assertContract(response, 'WithdrawRulesResponse');
  expect(f.minimum).not.toHaveBeenCalled();
  expect(f.service.validate).not.toHaveBeenCalled();
});

it.each(['0', '-100', '1.5', 'text', ''])(
  '[AC-B2-05c#72] 非正整数查询 amount_fen=%s → 20001 fields=[amount_fen]',
  async (amount) => {
    f = await httpFixture();
    const response = await f.request(`?amount_fen=${encodeURIComponent(amount)}`);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 20001, data: { fields: ['amount_fen'] } });
    expect(f.service.getRules).not.toHaveBeenCalled();
    await assertContract(response, 'ErrorEnvelope');
  },
);

it('[AC-B2-05c#73] h5_token 无提现读取作用域 → 10403', async () => {
  f = await httpFixture();
  const response = await f.request('', await f.h5());
  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({ code: 10403 });
  expect(f.service.getRules).not.toHaveBeenCalled();
  await assertContract(response, 'ErrorEnvelope');
});

it('[AC-B2-05c#74] 未登录 → 10001，开关和个人提现状态不泄露', async () => {
  f = await httpFixture();
  const response = await f.request('', null);
  expect(response.statusCode).toBe(401);
  expect(response.json()).toMatchObject({ code: 10001 });
  expect(f.service.getRules).not.toHaveBeenCalled();
  await assertContract(response, 'ErrorEnvelope');
});

it.each(['50', '125', '500100'])(
  '[AC-B2-05c#75] 正整数 %s 只转换为整数分，不做金额业务校验；身份从 token 读取',
  async (amount) => {
    f = await httpFixture();
    const response = await f.request(`?amount_fen=${amount}`, undefined, {
      'x-user-id': 'synthetic-attacker',
    });
    expect(response.statusCode).toBe(200);
    expect(f.service.getRules).toHaveBeenCalledWith(f.handle, actor, BigInt(amount));
    await assertContract(response, 'WithdrawRulesResponse');
  },
);

it('[AC-B2-05c#76] 劳务协议阻断也是成功的 rules 响应，估算 null 且无业务错误信封', async () => {
  f = await httpFixture();
  vi.mocked(f.service.getRules).mockResolvedValue({
    ...success,
    can_withdraw: false,
    block_code: 10004,
    max_withdrawable_fen: 0,
    est_fee_fen: null,
    est_tax_fen: null,
    est_net_fen: null,
  });
  const response = await f.request();
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    code: 0,
    data: {
      can_withdraw: false,
      block_code: 10004,
      block_reason: null,
      max_withdrawable_fen: 0,
      est_fee_fen: null,
      est_tax_fen: null,
      est_net_fen: null,
    },
  });
  await assertContract(response, 'WithdrawRulesResponse');
});
