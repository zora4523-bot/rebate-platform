// B2-04zd（D10-443）：ledger 差错单「以联盟为准」结论只读读口（BR-FUND-04 ④：结论为以联盟为准的视为一致）。
// 只认差错单结论（resolution），不以 closed 状态冒充。现有 resolution 写法（登记时由发现方给出、
// 后台关闭只记 reason）里没有可识别的「以联盟为准」结论，本测试按「恒 false」钉住，待编排裁定取值。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { MONTH, TIMEOUT, databaseFixture, newApp, readOnly, seedDiff, tableCounts } from './kit.ts';

// 经 ledger 公开出口运行时加载（不把 Nest 模块图引入测试 tsc）。
const ledger = (await import(
  new URL('../../../../apps/api/src/modules/ledger/index.ts', import.meta.url).href
)) as typeof import('../../../../apps/api/src/modules/ledger/application/recon-diff-conclusion.ts');

const database = databaseFixture(createTestDatabase);

function readKeys(appId: string, orderKeys: readonly string[]) {
  return readOnly(database.db, (trx) =>
    ledger.readUnionAuthoritativeOrderKeys(trx, { appId, orderKeys }),
  );
}

it(
  '[AC-B2-04zd#11] 无差错单或键列表为空时返回空集合',
  async () => {
    const appId = newApp();

    expect([...(await readKeys(appId, ['taobao:synthetic-none']))]).toEqual([]);
    expect([...(await readKeys(appId, []))]).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zd#12] 未结案（open / processing）的账单金额不一致差错单不算以联盟为准',
  async () => {
    const db = database.db;
    const appId = newApp();
    await seedDiff(db, appId, 'taobao:synthetic-open', { status: 'open' });
    await seedDiff(db, appId, 'taobao:synthetic-processing', { status: 'processing' });

    const keys = await readKeys(appId, ['taobao:synthetic-open', 'taobao:synthetic-processing']);

    expect([...keys]).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zd#13] 仅 closed 状态不冒充结论：后台关闭写入的 reason 即便是「以联盟为准」字样也不算',
  async () => {
    const db = database.db;
    const appId = newApp();
    await seedDiff(db, appId, 'taobao:synthetic-closed', { status: 'closed', resolution: null });
    await seedDiff(db, appId, 'taobao:synthetic-reason', {
      status: 'closed',
      resolution: { reason: '以联盟为准' },
    });
    await seedDiff(db, appId, 'taobao:synthetic-union', {
      type: 'union_mismatch',
      status: 'closed',
      resolution: { reason: '联盟结算明细已核对，差额由联盟侧调整' },
    });

    const keys = await readKeys(appId, [
      'taobao:synthetic-closed',
      'taobao:synthetic-reason',
      'taobao:synthetic-union',
    ]);

    expect([...keys]).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zd#14] 读口不臆造取值：adjusted / written_off 及 resolution 里任意自拟键均不识别（恒 false，待编排裁定）',
  async () => {
    const db = database.db;
    const appId = newApp();
    await seedDiff(db, appId, 'taobao:synthetic-adjusted', { status: 'adjusted' });
    await seedDiff(db, appId, 'taobao:synthetic-written', { status: 'written_off' });
    await seedDiff(db, appId, 'taobao:synthetic-guess', {
      status: 'closed',
      resolution: { conclusion: 'union', union_authoritative: true, decision: 'UNION' },
    });
    await seedDiff(db, appId, 'taobao:synthetic-later', {
      status: 'adjusted',
      period: '2032-07',
      resolution: { conclusion: '以联盟为准' },
    });

    const keys = await readKeys(appId, [
      'taobao:synthetic-adjusted',
      'taobao:synthetic-written',
      'taobao:synthetic-guess',
      'taobao:synthetic-later',
    ]);

    expect([...keys]).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04zd#15] 只读：在只读事务里完成，差错单行与各表行数不变',
  async () => {
    const db = database.db;
    const appId = newApp();
    await seedDiff(db, appId, 'taobao:synthetic-ro', { status: 'closed', period: MONTH });
    const before = await tableCounts(db, appId);
    const rows = await db
      .withSchema('app')
      .selectFrom('recon_diffs')
      .selectAll()
      .where('app_id', '=', appId)
      .execute();

    const keys = await readKeys(appId, ['taobao:synthetic-ro']);

    expect([...keys]).toEqual([]);
    expect(await tableCounts(db, appId)).toEqual(before);
    expect(
      await db
        .withSchema('app')
        .selectFrom('recon_diffs')
        .selectAll()
        .where('app_id', '=', appId)
        .execute(),
    ).toEqual(rows);
  },
  TIMEOUT,
);
