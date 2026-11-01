// B1-09p · actual_fen、clawback_fen、has_clawback、part_clawed_at（BR-TEXT-02 金额字段，D10-558
// ①②③）：只读查看者本账户的真实分录。恢复、改派的口径待判，本文件不铺这类凭证。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  credited,
  fixture,
  useDatabase,
  waiting,
  type Fixture,
  type OrderPatch,
  type SeededOrder,
} from './kit.ts';

const pg = useDatabase(createTestDatabase);
const EARLY = '2027-12-05T02:00:00.000Z';
const LATE = '2027-12-09T02:00:00.000Z';
const withoutAmounts: readonly {
  readonly label: string;
  readonly patch: OrderPatch;
  readonly display_status: string;
  readonly extra: Readonly<Record<string, unknown>>;
}[] = [
  { label: 'ESTIMATED', patch: {}, display_status: 'PAID', extra: {} },
  { label: 'WAITING', patch: waiting(), display_status: 'WAITING', extra: {} },
  { label: 'VOID', patch: { rebate_status: 'VOID' }, display_status: 'INVALID', extra: {} },
  {
    label: 'booked_base_fen=0',
    patch: credited({ booked_base_fen: 0n, booked_n_fen: 0n }),
    display_status: 'NO_REBATE',
    // Row 3 shows no amount, whatever the settled commission (1000) would give.
    extra: { est_rebate_fen: null },
  },
];

async function partClawedAt(f: Fixture, o: SeededOrder): Promise<number | null> {
  const node = (await f.detail(o))?.timeline.find((item) => item.node === 'part_clawed_back');
  return node?.at === undefined || node.at === null ? null : Date.parse(node.at);
}

it('[AC-B1-09p#28][BR-TEXT-02] 只有入账：已结算，实返 = 入账额，扣回 0', async () => {
  const f = await fixture(pg.db);
  const o = await f.order({ patch: credited() });
  await f.credit(o, { amount: 425n });
  expect(await f.detail(o)).toMatchObject({
    display_status: 'CREDITED',
    actual_fen: 425,
    clawback_fen: 0,
  });
  expect(await f.row(o)).toMatchObject({ display_status: 'CREDITED' });
}, 60_000);

it.each([
  { label: '正差', amounts: [17n], actual: 442 },
  { label: '负差', amounts: [-10n], actual: 415 },
  { label: '正负两笔', amounts: [17n, -10n], actual: 432 },
])(
  '[AC-B1-09p#29][BR-TEXT-02] SETTLE_ADJUST $label 按用户侧符号计入实返，不算扣回',
  async ({ amounts, actual }) => {
    const f = await fixture(pg.db);
    const o = await f.order({ patch: credited() });
    await f.credit(o, { amount: 425n });
    for (const amount of amounts) await f.adjust(o, { amount });
    expect(await f.detail(o)).toMatchObject({
      display_status: 'CREDITED',
      actual_fen: actual,
      clawback_fen: 0,
    });
  },
  60_000,
);

it('[AC-B1-09p#30][BR-TEXT-02][BR-FUND-17] 部分扣回：第 4 行，实返减去扣回额', async () => {
  const f = await fixture(pg.db);
  const o = await f.order({ patch: credited() });
  await f.credit(o, { amount: 425n });
  await f.clawback(o, { amount: 100n, at: EARLY });
  expect(await f.detail(o)).toMatchObject({
    display_status: 'CREDITED_PART_CLAWED',
    actual_fen: 325,
    clawback_fen: 100,
  });
  expect(await f.row(o)).toMatchObject({ display_status: 'CREDITED_PART_CLAWED' });
}, 60_000);

it('[AC-B1-09p#31][BR-TEXT-02] 公式合算：入账 425 + 补差 17 − 扣回 100 = 342', async () => {
  const f = await fixture(pg.db);
  const o = await f.order({ patch: credited() });
  await f.credit(o, { amount: 425n });
  await f.adjust(o, { amount: 17n });
  await f.clawback(o, { amount: 100n, at: EARLY });
  expect(await f.detail(o)).toMatchObject({ actual_fen: 342, clawback_fen: 100 });
}, 60_000);

it('[AC-B1-09p#32][BR-TEXT-02][D10-558] 多次扣回：金额累加，各 sub_type 都算，part_clawed_at 取最近一次', async () => {
  const f = await fixture(pg.db);
  const o = await f.order({ patch: credited() });
  await f.credit(o, { amount: 425n });
  // Posted latest first: "most recent" is the booked time, not the insertion order.
  await f.clawback(o, { amount: 100n, sub: 'PART_REFUND', at: LATE });
  await f.clawback(o, { amount: 50n, sub: 'RIGHTS', at: EARLY });
  expect(await f.detail(o)).toMatchObject({
    display_status: 'CREDITED_PART_CLAWED',
    actual_fen: 275,
    clawback_fen: 150,
  });
  expect(await partClawedAt(f, o)).toBe(Date.parse(LATE));
}, 60_000);

it('[AC-B1-09p#33][BR-FUND-17][D10-558] 别的受益人与平台的 CLAWBACK、SETTLE_ADJUST 不影响本人', async () => {
  const f = await fixture(pg.db);
  const parent = await f.user();
  const o = await f.order({
    patch: credited(),
    people: [
      { userId: f.subject.user_id, role: 'self', ratioBp: 5000 },
      { userId: parent, role: 'direct', ratioBp: 1000 },
    ],
  });
  await f.credit(o, { amount: 425n });
  await f.credit(o, { amount: 85n, userId: parent, role: 'direct' });
  await f.adjust(o, { amount: 5n, userId: parent, role: 'direct' });
  await f.clawback(o, { amount: 20n, userId: parent, role: 'direct', at: LATE });
  await f.platformClawback(o, 30n);
  expect(await f.detail(o)).toMatchObject({
    display_status: 'CREDITED',
    actual_fen: 425,
    clawback_fen: 0,
  });
  expect(await partClawedAt(f, o)).toBeNull();
}, 60_000);

it('[AC-B1-09p#34][BR-TEXT-02][D10-558] 本人早、直推晚被扣回：金额和最近一次时间只算本人的', async () => {
  const f = await fixture(pg.db);
  const parent = await f.user();
  const o = await f.order({
    patch: credited(),
    people: [
      { userId: f.subject.user_id, role: 'self', ratioBp: 5000 },
      { userId: parent, role: 'direct', ratioBp: 1000 },
    ],
  });
  await f.credit(o, { amount: 425n });
  await f.credit(o, { amount: 85n, userId: parent, role: 'direct' });
  await f.clawback(o, { amount: 100n, at: EARLY });
  await f.clawback(o, { amount: 20n, userId: parent, role: 'direct', at: LATE });
  expect(await f.detail(o)).toMatchObject({
    display_status: 'CREDITED_PART_CLAWED',
    actual_fen: 325,
    clawback_fen: 100,
  });
  expect(await partClawedAt(f, o)).toBe(Date.parse(EARLY));
}, 60_000);

it('[AC-B1-09p#35][BR-TEXT-02] 分享单：SHARE_CREDIT 入账与本人扣回同样计入', async () => {
  const f = await fixture(pg.db);
  const o = await f.order({
    patch: credited({ buy_type: 'share' }),
    people: [{ userId: f.subject.user_id, role: 'share', ratioBp: 4000 }],
  });
  await f.credit(o, { amount: 340n, role: 'share' });
  await f.clawback(o, { amount: 40n, role: 'share', at: EARLY });
  expect(await f.detail(o)).toMatchObject({
    display_status: 'CREDITED_PART_CLAWED',
    actual_fen: 300,
    clawback_fen: 40,
  });
}, 60_000);

it.each(withoutAmounts)(
  '[AC-B1-09p#36][BR-TEXT-02][D10-558] $label 单有本人分录也不给实返与扣回',
  async ({ patch, display_status, extra }) => {
    const f = await fixture(pg.db);
    const o = await f.order({ patch });
    await f.credit(o, { amount: 425n });
    await f.clawback(o, { amount: 100n, at: EARLY });
    expect(await f.detail(o)).toMatchObject({
      display_status,
      actual_fen: null,
      clawback_fen: null,
      ...extra,
    });
  },
  60_000,
);

it('[AC-B1-09p#37][BR-TEXT-02] CLAWED_BACK 单：扣回额照给，不给实返，不走第 4 行', async () => {
  const f = await fixture(pg.db);
  const o = await f.order({ patch: credited({ rebate_status: 'CLAWED_BACK' }) });
  await f.credit(o, { amount: 425n });
  await f.clawback(o, { amount: 425n, sub: 'FULL', at: EARLY });
  expect(await f.detail(o)).toMatchObject({
    display_status: 'CLAWED_BACK',
    actual_fen: null,
    clawback_fen: 425,
  });
}, 60_000);

it('[AC-B1-09p#66][BR-TEXT-02][D10-558] CLAWED_BACK 单只有别的受益人被扣回：本人扣回 0', async () => {
  const f = await fixture(pg.db);
  const parent = await f.user();
  const o = await f.order({
    patch: credited({ rebate_status: 'CLAWED_BACK' }),
    people: [
      { userId: f.subject.user_id, role: 'self', ratioBp: 5000 },
      { userId: parent, role: 'direct', ratioBp: 1000 },
    ],
  });
  await f.credit(o, { amount: 425n });
  await f.credit(o, { amount: 85n, userId: parent, role: 'direct' });
  await f.clawback(o, { amount: 85n, userId: parent, role: 'direct', sub: 'FULL', at: EARLY });
  expect(await f.detail(o)).toMatchObject({
    display_status: 'CLAWED_BACK',
    actual_fen: null,
    clawback_fen: 0,
  });
}, 60_000);

it.each([
  { label: '快照里份额初始被剥夺', initialStatus: 'forfeited' },
  { label: '快照里份额正常', initialStatus: 'active' },
] as const)(
  '[AC-B1-09p#67][BR-TEXT-02] 已结算而本人无分录、无 open 义务（$label）：实返 0、扣回 0，不是 null',
  async ({ initialStatus }) => {
    const f = await fixture(pg.db);
    const o = await f.order({
      patch: credited(),
      people: [{ userId: f.subject.user_id, role: 'self', ratioBp: 5000, initialStatus }],
    });
    expect(await f.detail(o)).toMatchObject({
      display_status: 'CREDITED',
      actual_fen: 0,
      clawback_fen: 0,
    });
  },
  60_000,
);

it('[AC-B1-09p#69][BR-TEXT-02] VOID 单 est_rebate_fen 不得为正：0 或 null 都接受', async () => {
  const f = await fixture(pg.db);
  const o = await f.order({ patch: { rebate_status: 'VOID' } });
  const detail = await f.detail(o);
  const row = await f.row(o);
  expect(detail).toMatchObject({ display_status: 'INVALID' });
  expect(row).toMatchObject({ display_status: 'INVALID' });
  expect(detail?.est_rebate_fen ?? 0).toBe(0);
  expect(row?.est_rebate_fen ?? 0).toBe(0);
}, 60_000);
