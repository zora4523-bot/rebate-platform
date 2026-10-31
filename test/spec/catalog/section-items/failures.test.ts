// B1-05o: a union failure of one channel drops only that channel's page: one alert, its page number
// stays and the next request asks for the same page. Failure of every channel fetched is the empty
// answer, never 50304 (contract listPageSectionItems). A union-side error counts as a failure,
// a business refusal included (编排裁定 D10-473, as isFeedFailure of the search use case); a
// programming error (编排补充说明 D10-452) is not swallowed.
import { expect, it } from 'vitest';
import { GovernanceError } from '../../../../apps/api/src/modules/platform/index.ts';
import { DemoUnionError, UnionError } from '../../../../apps/api/src/modules/union/index.ts';
import { rejection, series } from '../hot-rank/kit.ts';
import { EMPTY, JD, TB, expectPages, names, pagesCursor, sectionFixture, titlesOf } from './kit.ts';

const OUTAGES = [
  {
    label: 'UnionError upstream_unavailable',
    outage: new UnionError('upstream_unavailable', 'synthetic unavailable', 'taobao'),
  },
  {
    label: 'UnionError rate_limited',
    outage: new UnionError('rate_limited', 'synthetic rate limited', 'taobao'),
  },
  {
    label: 'GovernanceError timeout',
    outage: new GovernanceError('timeout', 'union:taobao:online', 'synthetic slow'),
  },
  {
    label: 'GovernanceError circuit_open',
    outage: new GovernanceError('circuit_open', 'union:taobao:online', 'synthetic circuit open'),
  },
  {
    label: 'GovernanceError quota_exceeded',
    outage: new GovernanceError('quota_exceeded', 'union:taobao:online', 'synthetic quota'),
  },
];

const unavailable = (): UnionError =>
  new UnionError('upstream_unavailable', 'synthetic unavailable', 'taobao');

it.each(OUTAGES)(
  '[AC-B1-05o#22] 一个频道 $label：只丢这个频道这一页，别的频道照常下发，告警一条点名该频道，页码不前进',
  async ({ outage }) => {
    const f = sectionFixture();
    f.failChannel(TB, outage);
    f.answer(JD, 1, series('jd', 2, 1, 'jd'));

    const data = await f.run();

    expect(titlesOf(data)).toEqual(names('jd', 2));
    expectPages(data, [1, 0]);
    expect(f.warnings()).toEqual([
      expect.objectContaining({ platform: TB.platform, channel_id: TB.channel_id }),
    ]);
  },
);

it('[AC-B1-05o#23] 失败频道在下一请求重取同一页，答上来后接着往下走；已到底的频道不再取', async () => {
  const f = sectionFixture();
  f.failChannel(TB, unavailable());
  f.answer(JD, 1, series('jd', 2, 1, 'jd'));
  const first = await f.run();

  f.recover(TB);
  f.answer(TB, 1, series('tb', 2));
  const second = await f.run({ cursor: first.next_cursor! });

  expect(f.pageNos(TB)).toEqual([1, 1]);
  expect(f.pageNos(JD)).toEqual([1]);
  expect(titlesOf(second)).toEqual(names('tb', 2));
  expect(second.has_more).toBe(false);
  expect(second.next_cursor).toBeNull();
});

it('[AC-B1-05o#24] 失败频道同一请求内不重试：补足轮只取答过且还有下一页的频道', async () => {
  const f = sectionFixture();
  f.failChannel(TB, unavailable());
  f.answer(JD, 1, series('jd', 2, 1, 'jd'), true);
  f.answer(JD, 2, series('jd', 2, 3, 'jd'));

  const data = await f.run();

  expect(f.pageNos(TB)).toEqual([1]);
  expect(f.pageNos(JD)).toEqual([1, 2]);
  expect(titlesOf(data)).toEqual(names('jd', 4));
  expectPages(data, [1, 0]);
  expect(f.warnings()).toHaveLength(1);
});

it('[AC-B1-05o#25] 全部频道失败：空结果、has_more=false、next_cursor=null，每个频道各告警一条，不报 50304', async () => {
  const queries: readonly { readonly cursor?: string }[] = [{}, { cursor: pagesCursor([3, 5]) }];
  for (const query of queries) {
    const f = sectionFixture();
    f.failChannel(TB, unavailable());
    f.failChannel(JD, new GovernanceError('timeout', 'union:jd:online', 'synthetic slow'));

    const data = await f.run(query);

    expect(data).toEqual(EMPTY);
    expect(f.warnings()).toHaveLength(2);
  }
});

it('[AC-B1-05o#26] 还在取的频道全失败、其余已到底：没有频道答过，同样按空结果结束', async () => {
  const f = sectionFixture();
  f.failChannel(JD, unavailable());

  const data = await f.run({ cursor: pagesCursor([0, 4]) });

  expect(data).toEqual(EMPTY);
  expect(f.pageNos(TB)).toEqual([]);
  expect(f.pageNos(JD)).toEqual([4]);
  expect(f.warnings()).toHaveLength(1);
});

const DEFECTS = [
  { label: 'TypeError', defect: new TypeError('synthetic defect') },
  { label: 'RangeError', defect: new RangeError('synthetic defect') },
];

it.each(DEFECTS)(
  '[AC-B1-05o#27] 编程错误 $label 不算上游失败：原样上抛，别的频道答了也一样',
  async ({ defect }) => {
    const f = sectionFixture();
    f.failChannel(JD, defect);
    f.answer(TB, 1, series('tb', 2));

    const error = await rejection(() => f.run());

    expect(error === defect).toBe(true);
    expect(f.register).not.toHaveBeenCalled();
  },
);

const REFUSALS = [
  {
    label: 'GovernanceError invalid_policy',
    refusal: new GovernanceError('invalid_policy', 'union:jd:online', 'synthetic policy'),
  },
  {
    label: 'UnionError upstream_rejected',
    refusal: new UnionError('upstream_rejected', 'synthetic rejected', 'jd'),
  },
  {
    label: 'UnionError item_unavailable',
    refusal: new UnionError('item_unavailable', 'synthetic unavailable item', 'jd'),
  },
  {
    label: 'DemoUnionError',
    refusal: new DemoUnionError('demo_unknown_scenario', 'synthetic scenario', 'jd'),
  },
];

it.each(REFUSALS)(
  '[AC-B1-05o#28] $label 也算联盟失败：只丢这个频道这一页，别的频道照常下发并注册链接，告警一条点名该频道，页码不前进',
  async ({ refusal }) => {
    const f = sectionFixture();
    f.failChannel(JD, refusal);
    f.answer(TB, 1, series('tb', 2));

    const data = await f.run();

    expect(titlesOf(data)).toEqual(names('tb', 2));
    expect(f.registered()).toEqual(names('tb', 2));
    expectPages(data, [0, 1]);
    expect(f.warnings()).toEqual([
      expect.objectContaining({ platform: JD.platform, channel_id: JD.channel_id }),
    ]);
  },
);
