import { expect, it, vi } from 'vitest';
import { registerIdempotencyPostMissCheck } from '../../../../apps/api/src/modules/platform/index.ts';
import { HEADERS, PRINCIPAL, expectBlocked, fixture, request } from './kit.ts';
import { RESULT, STORED, idemFixture, idemRequest } from './idempotency-kit.ts';

for (const transactional of [false, true]) {
  const mode = transactional ? 'executeInTransaction' : 'execute';
  for (const state of ['completed', 'processing', 'abandoned'] as const) {
    it(`[AC-B1-03c#11] ${mode} ${state} 优先于 ④a，旧版本和受限会话不影响回放`, async () => {
      const input = idemRequest(transactional);
      const f = idemFixture(input, state);
      const check = vi.fn(async () => {
        throw new Error('post-miss must not run');
      });
      const handler = vi.fn(async () => RESULT);
      try {
        registerIdempotencyPostMissCheck(f.idem, check);
        const result = await f.execute(handler);
        if (state === 'completed')
          expect(result).toEqual({ status: 201, body: STORED, source: 'replay' });
        else
          expect(JSON.parse(result.body)).toMatchObject({
            code: state === 'processing' ? 40901 : 20903,
          });
        expect(check).not.toHaveBeenCalled();
        expect(handler).not.toHaveBeenCalled();
        expect(f.events).toEqual(['lookup']);
      } finally {
        await f.db.destroy();
      }
    });
  }

  it(`[AC-B1-03c#12] ${mode} 钩子拒绝之前没有写记录，也不运行任何后续校验或核销`, async () => {
    const input = idemRequest(transactional);
    const f = idemFixture(input);
    const refused = new Error('stage-4a-rejection');
    const first = vi.fn(async () => {
      f.events.push('4a');
      throw refused;
    });
    const later = vi.fn(async () => {
      f.events.push('ban-check');
    });
    const consumeStepUp = vi.fn();
    const handler = vi.fn(async () => {
      consumeStepUp();
      return RESULT;
    });
    try {
      registerIdempotencyPostMissCheck(f.idem, first);
      registerIdempotencyPostMissCheck(f.idem, later);
      await expect(f.execute(handler)).rejects.toBe(refused);
      expect(first).toHaveBeenCalledExactlyOnceWith(input);
      expect(f.events).toEqual(['lookup', '4a']);
      expect(f.statements.filter((sql) => /^(insert|update|delete)\b/i.test(sql))).toEqual([]);
      expect(later).not.toHaveBeenCalled();
      expect(consumeStepUp).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await f.db.destroy();
    }
  });

  it(`[AC-B1-03c#13] ${mode} 未命中才按顺序等待钩子；通过后执行并保存`, async () => {
    const f = idemFixture(idemRequest(transactional));
    const check = vi.fn(async () => {
      await Promise.resolve();
      f.events.push('4a');
    });
    try {
      registerIdempotencyPostMissCheck(f.idem, check);
      registerIdempotencyPostMissCheck(f.idem, async () => {
        f.events.push('5');
      });
      const result = await f.execute(async () => {
        f.events.push('handler');
        return RESULT;
      });
      expect(result.source).toBe('handler');
      expect(f.events).toEqual(['lookup', '4a', '5', 'insert', 'handler', 'update']);
      expect(check).toHaveBeenCalledTimes(1);
    } finally {
      await f.db.destroy();
    }
  });

  it(`[AC-B1-03c#14] ${mode} 实际版本检查返回 10405，不留记录；同键后续仍可重新判定`, async () => {
    const f = idemFixture(idemRequest(transactional));
    try {
      const gate = fixture();
      registerIdempotencyPostMissCheck(f.idem, async () => gate.check(request()));
      await expectBlocked(() => f.execute(), '2.10.3');
      expect(f.events).toEqual(['lookup']);
      gate.read.mockResolvedValue(null);
      expect((await f.execute()).source).toBe('handler');
      expect(gate.read).toHaveBeenCalledTimes(2);
    } finally {
      await f.db.destroy();
    }
  });

  it(`[AC-B1-03c#15] ${mode} 受限会话的已完成请求照常回放，不读取最低版本`, async () => {
    const f = idemFixture(idemRequest(transactional), 'completed');
    try {
      const gate = fixture();
      registerIdempotencyPostMissCheck(f.idem, async () =>
        gate.check(
          request({
            headers: { ...HEADERS, 'x-app-version': '0.0.0' },
            principal: { ...PRINCIPAL, scp: 'deletion_only' },
          }),
        ),
      );
      expect(await f.execute()).toEqual({ status: 201, body: STORED, source: 'replay' });
      expect(gate.read).not.toHaveBeenCalled();
    } finally {
      await f.db.destroy();
    }
  });

  it(`[AC-B1-03c#16] ${mode} 锁被另一处理中请求占用时仍 40901，不运行钩子`, async () => {
    const f = idemFixture(idemRequest(transactional), 'missing', false);
    const check = vi.fn(async () => undefined);
    try {
      registerIdempotencyPostMissCheck(f.idem, check);
      expect(JSON.parse((await f.execute()).body)).toMatchObject({ code: 40901 });
      expect(check).not.toHaveBeenCalled();
      expect(f.events).toEqual([]);
    } finally {
      await f.db.destroy();
    }
  });
}

it('[AC-B1-03c#17] 钩子注册隔离到幂等实例，不污染另一个 app 的执行链', async () => {
  const first = idemFixture(idemRequest(false));
  const second = idemFixture({ ...idemRequest(false), appId: 'other' });
  const check = vi.fn(async () => {
    throw new Error('first instance only');
  });
  try {
    registerIdempotencyPostMissCheck(first.idem, check);
    expect((await second.execute()).source).toBe('handler');
    expect(check).not.toHaveBeenCalled();
    await expect(first.execute()).rejects.toThrow('first instance only');
  } finally {
    await first.db.destroy();
    await second.db.destroy();
  }
});

it('[AC-B1-03c#23] execute 过期 processing 接管等同未命中：10405 不留下新接管记录，也不执行后续校验', async () => {
  const input = idemRequest(false);
  const f = idemFixture(input, 'expired-processing');
  const before = f.storedRow();
  const later = vi.fn(async () => undefined);
  const consumeStepUp = vi.fn();
  const handler = vi.fn(async () => {
    consumeStepUp();
    return RESULT;
  });
  try {
    const gate = fixture();
    const check = vi.fn(async () => {
      f.events.push('4a');
      await gate.check(
        request({ routeOptions: { url: '/v1/links/:link_id/open' }, body: input.body }),
      );
    });
    registerIdempotencyPostMissCheck(f.idem, check);
    registerIdempotencyPostMissCheck(f.idem, later);
    await expectBlocked(() => f.execute(handler), '2.10.3');
    expect(check).toHaveBeenCalledExactlyOnceWith(input);
    expect(gate.read).toHaveBeenCalledExactlyOnceWith('couli', 'ios', 'app_store');
    expect(f.events[0]).toBe('lookup');
    expect(f.events).toContain('4a');
    expect(f.events).not.toContain('insert');
    // Existing failure semantics allow preserving the old lease or removing it, never a
    // newly owned processing row or a saved 10405. The fixture tracks writes and rollback.
    const after = f.storedRow();
    expect(after === undefined || JSON.stringify(after) === JSON.stringify(before)).toBe(true);
    expect(later).not.toHaveBeenCalled();
    expect(consumeStepUp).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();

    // The expired key remains usable after the version restriction is removed.
    gate.read.mockResolvedValue(null);
    expect((await f.execute(handler)).source).toBe('handler');
    expect(check).toHaveBeenCalledTimes(2);
    expect(later).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(f.storedRow()).toMatchObject({ status: 'completed' });
  } finally {
    await f.db.destroy();
  }
});
