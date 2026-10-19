import { expect, it, vi } from 'vitest';
import { requestHashOf } from '../../../../apps/api/src/modules/platform/idempotency/index.ts';
import {
  BODY,
  CONTEXT,
  JSON_BODY,
  MODES,
  RESULT,
  SAVED,
  TRACE,
  completed,
  cryptoFixture,
  fixture,
  keyed,
  request,
  sha,
} from './kit.ts';

for (const mode of MODES) {
  it(`[AC-B1-01zzf#1] ${mode} 敏感请求写 hmac1 盲索引，使用独立上下文及规范化 JSON`, async () => {
    const crypto = cryptoFixture();
    const f = fixture(crypto);
    try {
      const response = await f.idem[mode](request(mode), async () => RESULT);
      expect(response).toEqual({ ...SAVED, source: 'handler' });
      expect(f.hashWrites()).toEqual([keyed(JSON_BODY)]);
      expect(crypto.blindIndex).toHaveBeenCalledWith(JSON_BODY, CONTEXT);
      expect(f.hashWrites()[0]).toMatch(/^hmac1:[0-9a-f]{64}$/u);
      expect(f.hashWrites()[0]).not.toBe(sha(JSON_BODY));
      expect(f.hashWrites()[0]).not.toBe(keyed(JSON_BODY, 37, 'users.phone'));
    } finally {
      await f.db.destroy();
    }
  });

  it(`[AC-B1-01zzf#2] ${mode} 递归排序与转义、数组顺序一致，五类敏感字段改变均改变摘要`, async () => {
    const crypto = cryptoFixture();
    const f = fixture(crypto);
    const samples: [unknown, string][] = [
      [
        { z: [null, { b: '甲\n"乙', a: -0 }], a: true },
        '{"a":true,"z":[null,{"a":0,"b":"甲\\n\\\"乙"}]}',
      ],
      [
        { a: true, z: [null, { a: 0, b: '甲\n"乙' }] },
        '{"a":true,"z":[null,{"a":0,"b":"甲\\n\\\"乙"}]}',
      ],
      [
        { a: true, z: [{ a: 0, b: '甲\n"乙' }, null] },
        '{"a":true,"z":[{"a":0,"b":"甲\\n\\\"乙"},null]}',
      ],
      [BODY, JSON_BODY],
    ];
    for (const field of Object.keys(BODY) as (keyof typeof BODY)[]) {
      const changed = { ...BODY, [field]: `${BODY[field]}x` };
      const ordered = Object.fromEntries(
        Object.entries(changed).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
      samples.push([changed, JSON.stringify(ordered)]);
    }
    try {
      for (const [body, canonical] of samples) {
        await f.idem[mode](request(mode, body), async () => RESULT);
        expect.soft(f.hashWrites().at(-1)).toBe(keyed(canonical));
        expect.soft(crypto.blindIndex).toHaveBeenCalledWith(canonical, CONTEXT);
      }
      expect(f.hashWrites()[0]).toBe(f.hashWrites()[1]);
      expect(new Set(f.hashWrites()).size).toBe(samples.length - 1);
    } finally {
      await f.db.destroy();
    }
  });

  it(`[AC-B1-01zzf#3] ${mode} 仅显式 true 改摘要，省略及 false 与 requestHashOf 保持 SHA-256`, async () => {
    const crypto = cryptoFixture();
    const f = fixture(crypto);
    try {
      const plain = { ...request(mode) };
      delete plain.keyedRequestDigest;
      for (const req of [plain, { ...plain, keyedRequestDigest: false }]) {
        await f.idem[mode](req, async () => RESULT);
        expect(f.hashWrites().at(-1)).toBe(sha(JSON_BODY));
      }
      expect(crypto.blindIndex).not.toHaveBeenCalled();
      expect(requestHashOf(BODY)).toBe(sha(JSON_BODY));
      await f.idem[mode](request(mode), async () => RESULT);
      expect(f.hashWrites()).toEqual([sha(JSON_BODY), sha(JSON_BODY), keyed(JSON_BODY)]);
      expect(requestHashOf(BODY)).toBe(sha(JSON_BODY));
    } finally {
      await f.db.destroy();
    }
  });

  it(`[AC-B1-01zzf#4] ${mode} 新旧记录同体逐字节重放、异体 20901，带前缀值绝不退回 SHA 比对`, async () => {
    const cases = [
      [keyed(JSON_BODY), true],
      [sha(JSON_BODY), true],
      [keyed('{"name":"另一个人"}'), false],
      [sha('{"name":"另一个人"}'), false],
      [`hmac1:${sha(JSON_BODY)}`, false],
      [keyed(JSON_BODY, 37, 'users.phone'), false],
    ] as const;
    for (const [hash, same] of cases) {
      const f = fixture({ ...cryptoFixture(), row: completed(hash) });
      const handler = vi.fn(async () => RESULT);
      try {
        const response = await f.idem[mode](request(mode), handler);
        if (same) expect.soft(response).toEqual({ ...SAVED, source: 'replay' });
        else {
          expect.soft(response.status).toBe(409);
          expect.soft(JSON.parse(response.body)).toMatchObject({ code: 20901, trace_id: TRACE });
        }
        expect(handler).not.toHaveBeenCalled();
        expect(f.writes()).toEqual([]);
      } finally {
        await f.db.destroy();
      }
    }
  });

  it(`[AC-B1-01zzf#5] ${mode} 咨询锁被占时仍可重放新旧同体记录，异体保持 40901`, async () => {
    for (const [hash, same] of [
      [keyed(JSON_BODY), true],
      [sha(JSON_BODY), true],
      [keyed('null'), false],
    ] as const) {
      const f = fixture({ ...cryptoFixture(), row: completed(hash), lockHeld: true });
      const handler = vi.fn(async () => RESULT);
      try {
        const response = await f.idem[mode](request(mode), handler);
        if (same) expect.soft(response).toEqual({ ...SAVED, source: 'replay' });
        else {
          expect.soft(response.status).toBe(409);
          expect.soft(JSON.parse(response.body)).toMatchObject({ code: 40901 });
        }
        expect(handler).not.toHaveBeenCalled();
        expect(f.writes()).toEqual([]);
      } finally {
        await f.db.destroy();
      }
    }
  });
}

it('[AC-B1-01zzf#6] 接管过期 processing 行也只写带前缀 HMAC', async () => {
  const old = '2031-05-06T07:00:00.000Z';
  const row = {
    ...completed(sha(JSON_BODY)),
    status: 'processing',
    response: null,
    created_at: new Date(old),
    ownership_created_at: old,
  };
  const f = fixture({ ...cryptoFixture(), row });
  const handler = vi.fn(async () => RESULT);
  try {
    expect(await f.idem.execute(request('execute'), handler)).toEqual({
      ...SAVED,
      source: 'handler',
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(f.hashWrites()).toEqual([keyed(JSON_BODY)]);
  } finally {
    await f.db.destroy();
  }
});

it('[AC-B1-01zzf#7] 同一规范化请求使用不同盲索引密钥时写入不同指纹', async () => {
  const hashes: unknown[] = [];
  for (const keyByte of [37, 83]) {
    const f = fixture(cryptoFixture(keyByte));
    try {
      await f.idem.execute(request('execute'), async () => RESULT);
      expect.soft(f.hashWrites()).toEqual([keyed(JSON_BODY, keyByte)]);
      hashes.push(f.hashWrites()[0]);
    } finally {
      await f.db.destroy();
    }
  }
  expect(hashes[0]).not.toBe(hashes[1]);
});
