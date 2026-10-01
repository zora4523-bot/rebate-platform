// One-time bootstrap of an environment, run by a superuser (ADR-0001 §4.2 #8):
// roles, the `couli` database owned by couli_migrator, and extensions.
//
//   PG_ADMIN_URL=postgres://postgres:...@host:port/postgres node scripts/bootstrap.ts
//
// When APP_ENV=local the five roles get the local password (COULI_DB_LOCAL_PASSWORD, default
// `couli_local`). In every other environment passwords are set outside this repository.
import { redactPgUrl } from '../src/pg-url.ts';
import {
  applyExtensions,
  applyRoles,
  createDatabaseIfMissing,
  DB_ROLES,
  setRolePasswords,
  waitForPg,
} from '../src/testing/provision.ts';
import { APP_DATABASE, localPassword } from './local-env.ts';
import { info, main, requireEnv } from './util.ts';

await main(async () => {
  const adminUrl = requireEnv(
    'PG_ADMIN_URL',
    '它是超级用户连接串，只用于初始化；本地直接用 pnpm dev:stack 即可。',
  );
  const appEnv = process.env['APP_ENV'] ?? '';
  info(`初始化数据库：${redactPgUrl(adminUrl)}（APP_ENV=${appEnv === '' ? '未设置' : appEnv}）`);

  await waitForPg(adminUrl, 30_000);
  await applyRoles(adminUrl);
  info(`角色已就绪：${DB_ROLES.join('、')}`);

  if (appEnv === 'local') {
    const password = localPassword();
    await setRolePasswords(adminUrl, Object.fromEntries(DB_ROLES.map((role) => [role, password])));
    info('已为五个角色设置本地密码（COULI_DB_LOCAL_PASSWORD）。');
  } else {
    info('非 local 环境：角色密码不由本脚本设置，请在仓库之外为各角色设置密码。');
  }

  const created = await createDatabaseIfMissing(adminUrl, APP_DATABASE, 'couli_migrator');
  info(
    created
      ? `已创建数据库 ${APP_DATABASE}（属主 couli_migrator）。`
      : `数据库 ${APP_DATABASE} 已存在。`,
  );

  await applyExtensions(adminUrl, APP_DATABASE);
  info('扩展已就绪（vector）。');
});
