import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { withHttp } from './http-kit.ts';
import { PAID } from './kit.ts';

it('[AC-B1-10b#43] 无DB与Redis可启动；POST与GET都失败关闭50001', async () => {
  await withHttp(
    { subject: { app_id: 'claims_unavailable', user_id: randomUUID() } },
    async (send) => {
      expect(
        (await send({ platform: 'jd', order_no: 'missing', paid_date: PAID })).json().code,
      ).toBe(50001);
      expect((await send()).json().code).toBe(50001);
    },
  );
}, 30_000);
