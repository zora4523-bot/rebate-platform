import { expect, it, vi } from 'vitest';
import { envelopeValidator } from '../errors/kit.ts';
import { PATH, withProbe } from './http-kit.ts';
import { BODY, MODES, RESULT, cryptoFixture, fixture, request } from './kit.ts';

for (const mode of MODES) {
  for (const fault of ['missing', 'throws'] as const) {
    it(`[AC-B1-01zzf#10] ${mode} FieldCrypto ${fault} 返回 HTTP 50001，不写幂等行、不执行用例`, async () => {
      const crypto = cryptoFixture();
      crypto.blindIndex.mockImplementation(() => {
        throw new Error('blind index unavailable');
      });
      const f = fixture(fault === 'missing' ? {} : crypto);
      const handler = vi.fn(async () => RESULT);
      const validate = await envelopeValidator();
      try {
        // 未选择 keyed 的操作在密钥缺失 / 出错时仍保持原行为。
        const ordinary = { ...request(mode), keyedRequestDigest: false };
        expect(await f.idem[mode](ordinary, async () => RESULT)).toMatchObject({
          source: 'handler',
        });
        expect(crypto.blindIndex).not.toHaveBeenCalled();
        f.statements.length = 0;
        await withProbe(
          (body) => f.idem[mode](request(mode, body), handler),
          async (app) => {
            const response = await app.inject({
              method: 'POST',
              url: PATH,
              headers: { 'content-type': 'application/json' },
              payload: JSON.stringify(BODY),
            });
            expect.soft(response.statusCode).toBe(500);
            const body: unknown = JSON.parse(response.body);
            expect.soft(body).toMatchObject({ code: 50001, trace_id: expect.any(String) });
            expect.soft(validate(body), JSON.stringify(validate.errors)).toBe(true);
            expect.soft(handler).not.toHaveBeenCalled();
            expect.soft(f.writes()).toEqual([]);
          },
        );
      } finally {
        await f.db.destroy();
      }
    });
  }
}
