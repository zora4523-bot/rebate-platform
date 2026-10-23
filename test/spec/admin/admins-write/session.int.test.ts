import { acquireTestRedis, createTestDatabase } from '@couli/db/testing';
import { it } from 'vitest';
import { alive, dead, harness, setup, signInAgain } from './kit.ts';

// Task §9: besides the per-account voiding instant, the admin check confirms on every request
// that the account's authenticator is still bound (admin/application/admin-check.ts).
const h = harness(createTestDatabase, acquireTestRedis);

it('[AC-B1-34h#26] 已登录账号在库里变为未绑定验证器后，其 admin_token 的下一次请求即 10001', async () => {
  const f = await setup(h);
  const a = await f.target();
  const own = await signInAgain(f, a);
  await alive(f, own.admin_token);
  await h.db
    .updateTable('admin_users')
    .set({ totp_bound_at: null })
    .where('id', '=', a.id)
    .execute();
  await dead(f, own.admin_token);
  await alive(f, f.token);
});
