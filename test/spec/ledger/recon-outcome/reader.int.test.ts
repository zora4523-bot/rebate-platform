// B2-09h read port rule tests (claude-independent, SPEC_REF 9ab94dc0): the task brief and 编排裁定
// D10-447 ②, D10-468 ②: readUnionAuthoritativeOrderKeys reads recon_diffs — source R1, ref_type
// order, ref_id in the given keys, status closed, resolution.outcome = 'union', of the given app.
// `closed` by itself, outcome=ours, no outcome and a free-text reason do not count. The rows are
// written directly (kit.ts), as closes and registrations would have left them; the port runs in a
// read-only transaction, so a write or a row lock would be refused. Top-level it() only (规划/11
// §4.3). bill-source passes every order key of the platform, so the list has no useful upper bound.
import { expect, it } from 'vitest';
import {
  allDiffs,
  fixture,
  ledger,
  orderKey,
  suite,
  unionDiff,
  unionKeys,
  type DiffRow,
} from './kit.ts';

const s = suite();

it('[AC-B2-09h#8] 读口只认 outcome=union：source R1、ref_type order、status closed、本 app、在所给键内（类型不限）才返回；ours、无 outcome、resolution 为空、别的 app、R2 / R3 / R4、open / processing / adjusted / written_off、ref_type 不是 order、未询问的键都不算', async () => {
  const f = fixture(s);
  const other = fixture(s);
  const yes = [
    await unionDiff(f),
    await unionDiff(f, { type: 'union_mismatch' }),
    await unionDiff(f, { type: 'settle_missing', ref_id: orderKey().replace('taobao:', 'jd:') }),
  ];
  const no = [
    await unionDiff(f, { resolution: { reason: '以我方为准', outcome: 'ours' } }),
    await unionDiff(f, { resolution: { reason: '以联盟为准' } }),
    await unionDiff(f, { resolution: null }),
    await unionDiff(f, { source: 'R2' }),
    await unionDiff(f, { source: 'R3' }),
    await unionDiff(f, { source: 'R4' }),
    await unionDiff(f, { status: 'open', closed_at: null }),
    await unionDiff(f, { status: 'processing', closed_at: null }),
    await unionDiff(f, { status: 'adjusted' }),
    await unionDiff(f, { status: 'written_off' }),
    await unionDiff(f, { ref_type: 'account' }),
    await unionDiff(f, { ref_type: 'withdrawal' }),
  ];
  const foreign = await unionDiff(other);
  const unasked = await unionDiff(f);

  const keys = [...yes, ...no, foreign].map((row) => row.ref_id);
  expect(await unionKeys(f.db, f.appId, keys)).toEqual(yes.map((row) => row.ref_id).sort());
  expect(await unionKeys(f.db, f.appId, [unasked.ref_id])).toEqual([unasked.ref_id]);
  expect(await unionKeys(f.db, other.appId, keys)).toEqual([foreign.ref_id]);
});

it('[AC-B2-09h#9] 只认键 outcome 的精确值：大小写不同、中文、数组或对象、嵌套在别的键下、其他键名、自由文本 reason 里写 union 都不算，与真正的 union 单同批查询时互不影响', async () => {
  const f = fixture(s);
  const lookalikes = [
    { reason: '核对', outcome: 'UNION' },
    { reason: '核对', outcome: 'Union' },
    { reason: '核对', outcome: ' union' },
    { reason: '核对', outcome: '以联盟为准' },
    { reason: '核对', outcome: ['union'] },
    { reason: '核对', outcome: { value: 'union' } },
    { reason: '核对', outcome: true },
    { reason: '核对', outcome: null },
    { reason: '核对', detail: { outcome: 'union' } },
    { reason: '核对', conclusion: 'union' },
    { reason: 'outcome=union' },
    { reason: 'union' },
  ];
  const rows: DiffRow[] = [];
  for (const resolution of lookalikes) rows.push(await unionDiff(f, { resolution }));
  const real = await unionDiff(f);

  const keys = [...rows, real].map((row) => row.ref_id);
  expect(await unionKeys(f.db, f.appId, keys)).toEqual([real.ref_id]);
});

it('[AC-B2-09h#10] 在所给句柄上读：同一事务里未提交的结论只有该事务看得见，别的连接看不见；只读事务里完成，差错单一行不变', async () => {
  const f = fixture(s);
  const key = orderKey();
  await f.db.transaction().execute(async (trx) => {
    await unionDiff({ ...f, db: trx }, { ref_id: key });
    const selection = { appId: f.appId, orderKeys: [key] };
    expect([...(await ledger.readUnionAuthoritativeOrderKeys(trx, selection))]).toEqual([key]);
    expect([...(await ledger.readUnionAuthoritativeOrderKeys(f.db, selection))]).toEqual([]);
  });

  const before = await allDiffs(f);
  expect(await unionKeys(f.db, f.appId, [key])).toEqual([key]);
  expect(await allDiffs(f)).toEqual(before);
});

it('[AC-B2-09h#11] 键数超过 PostgreSQL 单条语句的参数上限（65535）照常返回：账单来源传的是该平台全部子订单键，月结不能因单量失败；所给键重复时结果不重复', async () => {
  const f = fixture(s);
  const real = await unionDiff(f);
  const crowd = Array.from({ length: 70_000 }, (_, i) => `taobao:synthetic-crowd-${i}`);

  const keys = [...crowd, real.ref_id, real.ref_id];
  expect(await unionKeys(f.db, f.appId, keys)).toEqual([real.ref_id]);
});
