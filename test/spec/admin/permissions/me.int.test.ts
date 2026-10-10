import { expect, it } from 'vitest';
import { account, fixture, signedIn, useHarness } from '../auth/kit.ts';
import { ME, ok, registered, type Me } from '../step-up/kit.ts';
import { enumKeys, expectedGrants } from './expected.ts';

const h = useHarness();

it('[AC-F1-06l#3] 超管无需权限行即按枚举顺序拥有全部权限，含档位与操作例外', async () => {
  const f = await fixture(h, { probes: true });
  const a = await registered(h, true);
  const session = await signedIn(f, a);
  const data = await ok<Me>(await f.read(session.admin_token), ME);
  expect(data).toEqual({
    admin_id: a.id,
    username: a.username,
    is_super: true,
    verify_phone_masked: `${a.number.slice(0, 3)}****${a.number.slice(-4)}`,
    permissions: expectedGrants(enumKeys()),
  });
}, 30_000);

it('[AC-F1-06l#4] 普通账号仅返回自身已勾选且在枚举内的权限，按枚举排序并脱敏手机号', async () => {
  const f = await fixture(h, { probes: true });
  const a = await registered(h);
  const other = await account(h);
  const keys = ['fund.recon', 'fund.adjust', 'content.app_version', 'withdraw.review', 'fund.view'];
  for (const [adminId, permissions] of [
    [a.id, [...keys, 'retired.unknown']],
    [other.id, ['user.list']],
  ] as const) {
    await h.db
      .insertInto('admin_permissions')
      .values(
        permissions.map((permission_key) => ({
          app_id: 'couli',
          admin_id: adminId,
          permission_key,
          granted_by: other.id,
          granted_at: f.clock.now(),
        })),
      )
      .execute();
  }
  const session = await signedIn(f, a);
  const response = await f.read(session.admin_token);
  const data = await ok<Me>(response, ME);
  expect(data).toEqual({
    admin_id: a.id,
    username: a.username,
    is_super: false,
    verify_phone_masked: `${a.number.slice(0, 3)}****${a.number.slice(-4)}`,
    permissions: expectedGrants(keys),
  });
  expect(JSON.stringify(response.json())).not.toContain(a.number);
}, 30_000);

it('[AC-F1-06l#5] 无权限普通账号仍可登录，真实接口返回空集和未登记手机号 null', async () => {
  const f = await fixture(h, { probes: true });
  const a = await account(h);
  const session = await signedIn(f, a);
  expect(await ok<Me>(await f.read(session.admin_token), ME)).toEqual({
    admin_id: a.id,
    username: a.username,
    is_super: false,
    verify_phone_masked: null,
    permissions: [],
  });
}, 30_000);
