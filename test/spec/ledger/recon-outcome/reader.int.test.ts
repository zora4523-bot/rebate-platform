// B2-09h read port rule tests (claude-independent, SPEC_REF 9ab94dc0): the task brief and 编排裁定
// D10-447 ②, D10-468 ②, D10-506 ① ②: readUnionAuthoritativeOrderKeys reads recon_diffs — type
// settle_amount_mismatch, source R1, ref_type order, ref_id in the given keys, status closed,
// resolution.outcome = 'union', of the given app — and answers each conclusion with its expected_fen
// and actual_fen. `closed` by itself, outcome=ours, no outcome and a free-text reason do not count.
// CT-24zf contract r3: a #AMT# row is the order's difference too, matched exactly on the order_key;
// of the differences of the same amounts the last one closed with an outcome speaks (kit.ts).
// The rows are written directly (kit.ts), as closes and registrations would have left them; the port
// runs in a read-only transaction, so a write or a row lock would be refused. Top-level it() only
// (规划/11 §4.3). bill-source passes every order key of the platform, so the list has no useful upper
// bound.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  ago,
  allDiffs,
  amountDiff,
  fixture,
  ledger,
  orderKey,
  suite,
  unionConclusions,
  unionDiff,
  unionKeys,
  type DiffRow,
  type DiffSeed,
  type Resolution,
} from './kit.ts';

const s = suite();
const UNION = { reason: '以联盟为准', outcome: 'union' };
const OURS = { reason: '以我方为准', outcome: 'ours' };

/** Two ids, the lower first (uuid order = hex text order). */
function idPair(): [string, string] {
  return [randomUUID(), randomUUID()].sort() as [string, string];
}

it('[AC-B2-09h#8] 读口只认 outcome=union：type settle_amount_mismatch、source R1、ref_type order、status closed、本 app、在所给键内才返回；ours、无 outcome、resolution 为空、别的 app、别的类型（union_mismatch、settle_missing，带 union 的旧数据）、R2 / R3 / R4、open / processing / adjusted / written_off、ref_type 不是 order、未询问的键都不算', async () => {
  const f = fixture(s);
  const other = fixture(s);
  const yes = [
    await unionDiff(f),
    await unionDiff(f, { ref_id: orderKey().replace('taobao:', 'jd:') }),
  ];
  const no = [
    await unionDiff(f, { type: 'union_mismatch' }),
    await unionDiff(f, { type: 'settle_missing' }),
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
    const inside = await ledger.readUnionAuthoritativeOrderKeys(trx, selection);
    const outside = await ledger.readUnionAuthoritativeOrderKeys(f.db, selection);
    expect([...inside.keys()]).toEqual([key]);
    expect([...outside.keys()]).toEqual([]);
  });

  const before = await allDiffs(f);
  expect(await unionKeys(f.db, f.appId, [key])).toEqual([key]);
  expect(await allDiffs(f)).toEqual(before);
});

it('[AC-B2-09h#11] 键数超过 PostgreSQL 单条语句的参数上限（65535）照常返回：账单来源传的是该平台全部子订单键，月结不能因单量失败；所给键重复时结果不重复', async () => {
  const f = fixture(s);
  const real = await unionDiff(f);
  const later = orderKey();
  await unionDiff(f, amountDiff(later, 600n, 1_100n));
  const crowd = Array.from({ length: 70_000 }, (_, i) => `taobao:synthetic-crowd-${i}`);

  const keys = [...crowd, real.ref_id, real.ref_id, later];
  expect(await unionKeys(f.db, f.appId, keys)).toEqual([real.ref_id, later].sort());
});

it('[AC-B2-09h#20] D10-506 ②：读口按单返回每张 union 结论结案时的 expected_fen / actual_fen（bigint 原值，含 0 与超出 JS 安全整数的金额）；同一单多张 union 结论（别的账单月）全部返回；同单的 ours 结论与未询问的单不混入，所给键重复时不重复', async () => {
  const f = fixture(s);
  const single = await unionDiff(f, { expected_fen: 0n, actual_fen: 1_100n, diff_fen: 1_100n });
  const huge = 9_007_199_254_740_993n;
  const large = await unionDiff(f, { expected_fen: huge, actual_fen: 1n, diff_fen: 1n - huge });
  const twice = await unionDiff(f, { period: '2026-08' });
  await unionDiff(f, {
    ref_id: twice.ref_id,
    period: '2026-09',
    expected_fen: 600n,
    actual_fen: 1_100n,
    diff_fen: 500n,
  });
  await unionDiff(f, {
    ref_id: twice.ref_id,
    period: '2026-10',
    expected_fen: 700n,
    actual_fen: 1_100n,
    diff_fen: 400n,
    resolution: { reason: '以我方为准', outcome: 'ours' },
  });
  const unasked = await unionDiff(f);

  const keys = [single.ref_id, large.ref_id, twice.ref_id, twice.ref_id];
  const read = await unionConclusions(f.db, f.appId, keys);

  expect(new Set(read.keys())).toEqual(new Set([single.ref_id, large.ref_id, twice.ref_id]));
  expect(read.has(unasked.ref_id)).toBe(false);
  expect(read.get(single.ref_id)).toEqual([{ expectedFen: 0n, actualFen: 1_100n }]);
  expect(read.get(large.ref_id)).toEqual([{ expectedFen: huge, actualFen: 1n }]);
  const both = read.get(twice.ref_id) ?? [];
  expect(both).toHaveLength(2);
  expect(both).toEqual(
    expect.arrayContaining([
      { expectedFen: 1_234n, actualFen: 1_100n },
      { expectedFen: 600n, actualFen: 1_100n },
    ]),
  );
});

it('[AC-B2-09h#30] #AMT# 行是该单的差错单：只有 #AMT# 行的单也返回，按 order_key 归属、金额取这一行，和裸行的结论都给；ours、无 outcome、别的 source / status / type / ref_type 的 #AMT# 行不算，别的 app 看不见', async () => {
  const f = fixture(s);
  const other = fixture(s);
  const only = orderKey();
  const both = orderKey();
  const excluded = orderKey();
  await unionDiff(f, amountDiff(only, 600n, 1_100n));
  await unionDiff(f, { ref_id: both });
  await unionDiff(f, amountDiff(both, 600n, 1_100n));
  const patches: DiffSeed[] = [
    { resolution: OURS },
    { resolution: { reason: '以联盟为准' } },
    { resolution: null },
    { source: 'R2' },
    { status: 'open', closed_at: null },
    { status: 'written_off' },
    { type: 'union_mismatch' },
    { ref_type: 'account' },
  ];
  for (const [i, patch] of patches.entries()) {
    await unionDiff(f, { ...amountDiff(excluded, 700n + BigInt(i), 1_100n), ...patch });
  }

  const read = await unionConclusions(f.db, f.appId, [only, both, excluded]);
  expect(new Set(read.keys())).toEqual(new Set([only, both]));
  expect(read.get(only)).toEqual([{ expectedFen: 600n, actualFen: 1_100n }]);
  expect(read.get(both)).toHaveLength(2);
  expect(read.get(both)).toEqual(
    expect.arrayContaining([
      { expectedFen: 1_234n, actualFen: 1_100n },
      { expectedFen: 600n, actualFen: 1_100n },
    ]),
  );
  expect((await unionConclusions(other.db, other.appId, [only, both])).size).toBe(0);
});

it('[AC-B2-09h#31] 前缀不误中：order_key 互为前缀时各归各的，后缀只认完整的 #AMT#（#EST#、#AMT、#AMTX#、大小写不同都不算）；键里的 _ % \\ . 按字面比较，不当通配符、也不漏掉自己的行；未询问的键不混入', async () => {
  const f = fixture(s);
  const short = orderKey();
  const long = `${short}0`;
  const unasked = `${short}1`;
  await unionDiff(f, { ref_id: short });
  await unionDiff(f, amountDiff(long, 600n, 1_100n));
  await unionDiff(f, { ref_id: long, period: '2026-08', expected_fen: 700n, diff_fen: 400n });
  await unionDiff(f, amountDiff(unasked, 800n, 1_100n));
  const nearly = [
    `${short}#EST#900`,
    `${short}#AMT`,
    `${short}#AMTX#900:1100`,
    `${short}AMT#900:1100`,
    `${short}#amt#900:1100`,
  ];
  for (const ref_id of nearly) {
    await unionDiff(f, { ref_id, expected_fen: 900n, diff_fen: 200n });
  }

  const read = await unionConclusions(f.db, f.appId, [short, long]);
  expect(new Set(read.keys())).toEqual(new Set([short, long]));
  expect(read.get(short)).toEqual([{ expectedFen: 1_234n, actualFen: 1_100n }]);
  expect(read.get(long)).toHaveLength(2);
  expect(read.get(long)).toEqual(
    expect.arrayContaining([
      { expectedFen: 600n, actualFen: 1_100n },
      { expectedFen: 700n, actualFen: 1_100n },
    ]),
  );
  expect((await unionConclusions(f.db, f.appId, [short.slice(0, -1)])).size).toBe(0);

  const stem = orderKey();
  for (const plain of [`${stem}ax`, `${stem}aax`, `${stem}x`]) {
    await unionDiff(f, amountDiff(plain, 600n, 1_100n));
  }
  const literal = [`${stem}_x`, `${stem}%x`, `${stem}\\x`, `${stem}.x`];
  expect((await unionConclusions(f.db, f.appId, literal)).size).toBe(0);
  for (const key of literal) await unionDiff(f, amountDiff(key, 700n, 1_100n));
  const found = await unionConclusions(f.db, f.appId, literal);
  expect(new Set(found.keys())).toEqual(new Set(literal));
  for (const key of literal) {
    expect(found.get(key), key).toEqual([{ expectedFen: 700n, actualFen: 1_100n }]);
  }
});

it('[AC-B2-09h#32] 同一单多张差错单金额相同：取最近结案、有 outcome 的那张（closed_at、id 倒序，不看账单月先后；跨账单、裸行与 #AMT# 行同理）：后结案的 ours 取消、后结案的 union 生效、后结案无 outcome 的不算数，同一金额只给一次；别的金额、别的单互不影响', async () => {
  const f = fixture(s);
  const conclude = (
    key: string,
    period: string,
    minutes: number,
    resolution: Resolution,
    patch: DiffSeed = {},
  ) => unionDiff(f, { ref_id: key, period, closed_at: ago(f, minutes), resolution, ...patch });

  const overruled = orderKey();
  await conclude(overruled, '2026-07', 30, UNION);
  await conclude(overruled, '2026-08', 20, OURS);
  const upheld = orderKey();
  await conclude(upheld, '2026-07', 30, OURS);
  await conclude(upheld, '2026-08', 20, UNION);
  const silent = orderKey();
  await conclude(silent, '2026-07', 30, UNION);
  await conclude(silent, '2026-08', 20, { reason: '不下结论' });
  const repeated = orderKey();
  await conclude(repeated, '2026-07', 30, UNION);
  await conclude(repeated, '2026-08', 20, UNION);
  const earlierBill = orderKey();
  await conclude(earlierBill, '2026-08', 30, OURS);
  await conclude(earlierBill, '2026-07', 20, UNION);
  const onAmountRow = orderKey();
  await conclude(onAmountRow, '2026-07', 30, UNION);
  await conclude(onAmountRow, '2026-08', 20, OURS, amountDiff(onAmountRow, 1_234n, 1_100n));

  const [low, high] = idPair();
  const tiedUnion = orderKey();
  await conclude(tiedUnion, '2026-08', 20, UNION, { id: high });
  await conclude(tiedUnion, '2026-07', 20, OURS, { id: low });
  const [lower, higher] = idPair();
  const tiedOurs = orderKey();
  await conclude(tiedOurs, '2026-08', 20, OURS, { id: higher });
  await conclude(tiedOurs, '2026-07', 20, UNION, { id: lower });
  const [first, second] = idPair();
  const closedAtFirst = orderKey();
  await conclude(closedAtFirst, '2026-07', 30, OURS, { id: second });
  await conclude(closedAtFirst, '2026-08', 20, UNION, { id: first });

  const otherAmounts = orderKey();
  await conclude(otherAmounts, '2026-07', 30, UNION);
  await conclude(otherAmounts, '2026-08', 20, OURS, { expected_fen: 600n, diff_fen: 500n });
  const neighbour = orderKey();
  await conclude(neighbour, '2026-07', 30, UNION);
  const stranger = orderKey();
  await conclude(stranger, '2026-08', 20, OURS);

  const standing = [
    upheld,
    silent,
    repeated,
    earlierBill,
    tiedUnion,
    closedAtFirst,
    otherAmounts,
    neighbour,
  ];
  const read = await unionConclusions(f.db, f.appId, [
    ...standing,
    overruled,
    onAmountRow,
    tiedOurs,
    stranger,
  ]);
  expect(new Set(read.keys())).toEqual(new Set(standing));
  for (const key of standing) {
    expect(read.get(key), key).toEqual([{ expectedFen: 1_234n, actualFen: 1_100n }]);
  }
});
