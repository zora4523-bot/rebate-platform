// B1-05o: before every fetch every channel of the data source is checked against the whitelist as
// it is now (BR-TEXT-17 细则「取数时再查一次」: the save check cannot see later whitelist changes). One
// channel missing or not selectable refuses the whole data source: nothing is fetched, the block has
// no data and one section_channel_refused alert names the channel.
import { expect, it } from 'vitest';
import { candidate, channel, type ChannelEntry, series } from '../hot-rank/kit.ts';
import {
  EMPTY,
  JD,
  PDD,
  TB,
  entryOf,
  expectPages,
  pagesCursor,
  sectionFixture,
  type ChannelRef,
} from './kit.ts';

const THREE = [TB, JD, PDD];

const KINDS: readonly {
  readonly kind: string;
  readonly broken: (ref: ChannelRef) => readonly ChannelEntry[];
}[] = [
  { kind: '已移出白名单', broken: () => [] },
  {
    kind: '已标为不可选',
    broken: (ref) => [channel(ref.platform, ref.channel_id, { selectable: false })],
  },
  {
    kind: '同名频道只登记在别的平台',
    broken: (ref) => [channel(ref.platform === 'taobao' ? 'jd' : 'taobao', ref.channel_id)],
  },
];

const REFUSED = KINDS.flatMap(({ kind, broken }) =>
  THREE.map((ref, position) => ({ label: `第 ${position + 1} 个频道${kind}`, position, broken })),
);

function answerAll(f: ReturnType<typeof sectionFixture>, pageNo: number): void {
  for (const ref of THREE) {
    f.answer(ref, pageNo, [candidate(`${ref.channel_id}-${pageNo}`, { platform: ref.platform })]);
  }
}

it.each(REFUSED)(
  '[AC-B1-05o#9] $label → 所有频道都不取，返回空结果并告警一条 section_channel_refused',
  async ({ position, broken }) => {
    const f = sectionFixture({ channels: THREE });
    answerAll(f, 1);
    const ref = THREE[position]!;
    f.setChannels(THREE.flatMap((entry, at) => (at === position ? broken(ref) : [entryOf(entry)])));

    const data = await f.run();

    expect(data).toEqual(EMPTY);
    expect(f.calls).toEqual([]);
    expect(f.assemble).not.toHaveBeenCalled();
    expect(f.register).not.toHaveBeenCalled();
    expect(f.warnings()).toEqual([
      expect.objectContaining({
        event: 'section_channel_refused',
        platform: ref.platform,
        channel_id: ref.channel_id,
      }),
    ]);
  },
);

it('[AC-B1-05o#10] 几个频道同时失效：同样一个都不取，告警里点名的是失效频道', async () => {
  const f = sectionFixture({ channels: THREE });
  answerAll(f, 1);
  f.setChannels([entryOf(JD)]);

  const data = await f.run();

  expect(data).toEqual(EMPTY);
  expect(f.calls).toEqual([]);
  const refused = f.warnings().filter((fields) => fields['event'] === 'section_channel_refused');
  expect(refused.length).toBeGreaterThan(0);
  for (const fields of refused) {
    expect([TB.channel_id, PDD.channel_id]).toContain(fields['channel_id']);
  }
});

it('[AC-B1-05o#11] 翻页也重新读白名单：频道失效后带游标的请求不再取数、不报错、按空结果告警，恢复后同一游标接着取', async () => {
  const f = sectionFixture();
  f.answer(TB, 1, series('tb', 10), true);
  f.answer(JD, 1, series('jd', 10, 1, 'jd'), true);
  f.answer(TB, 2, series('tb', 1, 11));
  f.answer(JD, 2, series('jd', 1, 11, 'jd'));

  const first = await f.run();
  expectPages(first, [2, 2]);
  const reads = f.channels.mock.calls.length;
  const calls = f.calls.length;

  f.setChannels([entryOf(TB), channel(JD.platform, JD.channel_id, { selectable: false })]);
  const refused = await f.run({ cursor: first.next_cursor! });

  expect(refused).toEqual(EMPTY);
  expect(f.channels.mock.calls.length).toBeGreaterThan(reads);
  expect(f.calls.length).toBe(calls);
  expect(f.warnings()).toEqual([
    expect.objectContaining({
      event: 'section_channel_refused',
      platform: JD.platform,
      channel_id: JD.channel_id,
    }),
  ]);

  f.setChannels([entryOf(TB), entryOf(JD)]);
  const resumed = await f.run({ cursor: first.next_cursor! });

  expect(resumed.items).toHaveLength(2);
  expect(f.pageNos(TB)).toEqual([1, 2]);
  expect(f.pageNos(JD)).toEqual([1, 2]);
});

it('[AC-B1-05o#12] 白名单在取数之前读：每个上游调用发生时，这次请求已经读过白名单', async () => {
  const f = sectionFixture({ channels: [TB] });
  f.answer(TB, 1, series('tb', 20), true);
  f.answer(TB, 2, series('tb', 20, 21));

  await f.run();
  const reads = f.channels.mock.calls.length;
  await f.run({ cursor: pagesCursor([2]) });

  expect(f.readsAtFetch).toHaveLength(2);
  expect(f.readsAtFetch[0]).toBeGreaterThan(0);
  expect(f.readsAtFetch[1]).toBeGreaterThan(reads);
});
