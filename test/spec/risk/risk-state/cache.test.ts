import { expect, it } from 'vitest';
import { BANNED, NORMAL, SUBJECT, policyFixture, request } from './policy-kit.ts';

it('[AC-B1-03h#5][BR-ID-01] 非敏感请求命中缓存，至迟 60 秒刷新（含无行 normal）', async () => {
  for (const initial of [null, NORMAL]) {
    const f = policyFixture(initial);
    try {
      const service = f.service();
      const r = request({ method: 'GET', path: '/v1/products/search' });
      await service.checkRequest(r);
      const reads = f.reads.length;
      expect(reads).toBeGreaterThan(0);
      await service.checkRequest(r);
      expect(f.reads).toHaveLength(reads);
      f.change(BANNED);
      f.clock.advanceMs(60_001);
      await expect(service.checkRequest(r)).rejects.toMatchObject({ response: { code: 10006 } });
      expect(f.reads.length).toBeGreaterThan(reads);
    } finally {
      await f.db.destroy();
    }
  }
});

const SENSITIVE = [
  { method: 'POST', path: '/v1/withdrawals' },
  { method: 'PUT', path: '/v1/me/payout-account' },
  { method: 'GET', path: '/v1/me/payout-account' },
  { method: 'POST', path: '/v1/me/phone' },
  { method: 'POST', path: '/v1/me/deletion' },
  { method: 'GET', path: '/v1/me/deletion' },
  { method: 'POST', path: '/v1/me/deletion/cancel' },
];
for (const route of SENSITIVE) {
  it(`[AC-B1-03h#6][BR-ID-01] ${route.method} ${route.path} 每次查库，不使用已预热缓存`, async () => {
    const f = policyFixture(NORMAL);
    try {
      const service = f.service();
      await service.readRiskState(SUBJECT);
      const r = request(route);
      for (let i = 0; i < 2; i++) {
        const before = f.reads.length;
        await service.checkRequest(r);
        expect(f.reads.length).toBeGreaterThan(before);
      }
      f.change(BANNED);
      if (!route.path.startsWith('/v1/me/deletion')) {
        await expect(service.checkRequest(r)).rejects.toMatchObject({ response: { code: 10006 } });
      } else {
        const before = f.reads.length;
        await expect(service.checkRequest(r)).resolves.toBeUndefined();
        expect(f.reads.length).toBeGreaterThan(before);
      }
    } finally {
      await f.db.destroy();
    }
  });
}

it('[AC-B1-03h#7][BR-ID-01] 主动 fresh 读取每次访问库；普通读取的缓存键同时含 app_id 和 user_id', async () => {
  const f = policyFixture(NORMAL);
  try {
    const service = f.service();
    await service.readRiskState(SUBJECT);
    const before = f.reads.length;
    await service.readRiskState(SUBJECT);
    expect(f.reads).toHaveLength(before);
    for (const subject of [
      { ...SUBJECT, app_id: 'another_app' },
      { ...SUBJECT, user_id: '019a0000-0000-7000-8000-000000000011' },
    ]) {
      const n = f.reads.length;
      await service.readRiskState(subject);
      expect(f.reads.length).toBeGreaterThan(n);
    }
    f.change(BANNED);
    for (let i = 0; i < 2; i++) {
      const n = f.reads.length;
      expect(await service.readRiskState(SUBJECT, { fresh: true })).toEqual(BANNED);
      expect(f.reads.length).toBeGreaterThan(n);
    }
  } finally {
    await f.db.destroy();
  }
});

it('[AC-B1-03h#23][BR-ID-01] 敏感查库失败不能回落到缓存 normal，也不能冒充无行', async () => {
  const f = policyFixture(NORMAL);
  try {
    const service = f.service();
    await service.readRiskState(SUBJECT);
    const unavailable = new Error('fixture database unavailable');
    f.failReads(unavailable);
    await expect(
      service.checkRequest(request({ method: 'POST', path: '/v1/withdrawals' })),
    ).rejects.toBeInstanceOf(Error);
    await expect(service.readRiskState(SUBJECT, { fresh: true })).rejects.toBeInstanceOf(Error);
    expect(f.reads.length).toBeGreaterThanOrEqual(3);
  } finally {
    await f.db.destroy();
  }
});

it('[AC-B1-03h#24][BR-ID-01] post-miss 使用传入的事务查库，不再从池借连接', async () => {
  const pool = policyFixture(NORMAL);
  const claim = policyFixture(BANNED);
  try {
    const service = pool.service();
    await expect(
      claim.db
        .transaction()
        .execute((trx) =>
          service.checkRequest(request({ method: 'POST', path: '/v1/withdrawals' }), trx),
        ),
    ).rejects.toMatchObject({ response: { code: 10006 } });
    expect(pool.reads).toHaveLength(0);
    expect(claim.reads.length).toBeGreaterThan(0);
  } finally {
    await pool.db.destroy();
    await claim.db.destroy();
  }
});
