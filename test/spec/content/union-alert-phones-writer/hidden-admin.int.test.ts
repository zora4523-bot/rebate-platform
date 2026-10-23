// F1-02zzj §9.2 ⑤ / §9.3 ⑤: after union wrote union.auth_alert_phones through the dedicated
// port, the admin configuration center (contracts/openapi.yaml adminListConfigItems …
// adminRollbackConfigItem) neither lists, returns nor accepts the key: the same 20001 as a key
// outside the registry, and nothing is written. Built on the frozen F1-10e kit.
import { expect, it } from 'vitest';
import { createUnionAlertPhonesWriter } from '../../../../apps/api/src/modules/content/index.ts';
import { useHarness } from '../../admin/auth/kit.ts';
import { memoryLogger } from '../../identity/sms-codes/kit.ts';
import {
  KEYS,
  batch,
  call,
  keyInvalid,
  listAll,
  rejected,
  rollback,
  setup,
  snapshot,
  stepUp,
  update,
  type Setup,
} from '../config-items/kit.ts';
import { configRegistry } from '../../../../apps/api/src/modules/content/domain/config-registry.ts';
import { KEY, MARK, cipherValue } from './kit.ts';

const h = useHarness();

/** Two versions through the port, as union's alert phone writes leave them. */
async function viaPort(f: Setup) {
  const { logger } = memoryLogger();
  const writer = createUnionAlertPhonesWriter({ clock: f.clock, logger });
  for (const expectedVersion of [0, 1]) {
    const result = await h.db.transaction().execute((trx) =>
      writer.write(trx, {
        appId: f.appId,
        value: cipherValue(expectedVersion + 1),
        expectedVersion,
        adminId: f.actor.id,
        reason: null,
      }),
    );
    expect(result).toEqual({ version: expectedVersion + 1 });
  }
  const before = await snapshot(h, f.appId);
  expect(before.items.map((row) => [row.key, row.version])).toEqual([[KEY, 2]]);
  expect(before.versions.map((row) => [row.key, row.version])).toEqual([
    [KEY, 1],
    [KEY, 2],
  ]);
  return before;
}

it('[AC-F1-02zzj#17] 后台配置列表不出该键：库里有端口写入的行，列表仍只按注册表列出，响应不含其值', async () => {
  const f = await setup(h);
  await viaPort(f);
  const items = await listAll(f);
  expect(items.map((item) => item.key)).not.toContain(KEY);
  expect(items.map((item) => item.key)).toStrictEqual(configRegistry().map((spec) => spec.key));
  expect(JSON.stringify(items)).not.toContain(MARK);
});

it('[AC-F1-02zzj#18] 后台单项与历史对该键 20001 [key]（与未登记键同错），响应不含其值', async () => {
  const f = await setup(h);
  await viaPort(f);
  for (const op of ['get', 'versions'] as const) {
    const response = await call(f, op, { key: KEY });
    await keyInvalid(response, op);
    expect(JSON.stringify(response.json())).not.toContain(MARK);
  }
});

it('[AC-F1-02zzj#19] 后台改值对该键 20001 [key]（版本对不对都一样），不写库', async () => {
  const f = await setup(h);
  const before = await viaPort(f);
  const token = await stepUp(f);
  for (const expectedVersion of [2, 0]) {
    await keyInvalid(
      await update(
        f,
        KEY,
        { value: cipherValue('admin'), expected_version: expectedVersion },
        { stepUp: token },
      ),
      'update',
    );
  }
  expect(await snapshot(h, f.appId)).toStrictEqual(before);
});

it('[AC-F1-02zzj#20] 后台批量含该键：整批 20001，fields 列出该键（与未登记键同错），不写库', async () => {
  const f = await setup(h);
  const before = await viaPort(f);
  await rejected(
    await batch(f, {
      items: [
        { key: KEYS.general, value: 6, expected_version: 0 },
        { key: KEY, value: cipherValue('admin'), expected_version: 2 },
      ],
    }),
    'batch',
    20001,
    { fields: [KEY] },
  );
  expect(await snapshot(h, f.appId)).toStrictEqual(before);
});

it('[AC-F1-02zzj#21] 后台回滚该键到旧版本：20001 [key]，不写库', async () => {
  const f = await setup(h);
  const before = await viaPort(f);
  await keyInvalid(
    await rollback(f, KEY, { to_version: 1, expected_version: 2 }, { stepUp: await stepUp(f) }),
    'rollback',
  );
  expect(await snapshot(h, f.appId)).toStrictEqual(before);
});
