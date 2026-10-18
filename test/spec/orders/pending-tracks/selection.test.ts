import { expect, it } from 'vitest';
import { at, attempt, card, select, uuid } from './kit.ts';

it('[AC-B1-08m#1] 第一档优先且按 open 时间而非上报时间选卡', async () => {
  const a = attempt(1, { jump_reported_at: at(19) });
  const b = attempt(2, { jump_reported_at: at(3) });
  const c = attempt(4);
  expect(await select([c, a, b])).toEqual([card(b)]);
});

it('[AC-B1-08m#2] 无上报时选较晚 open，同 link 的尝试也独立', async () => {
  const a = attempt(1);
  const b = attempt(3, { link_id: a.link_id });
  expect(await select([b, a])).toEqual([card(b)]);
});

it('[AC-S1-55#7] 同一 link 的尝试分别分档，取消的新尝试不能继承旧尝试的上报', async () => {
  const a1 = attempt(0, { jump_reported_at: at(1) });
  const a2 = attempt(5, { jump_reported_at: at(6) });
  const a3 = attempt(10, { link_id: a1.link_id });
  for (const input of [
    [a1, a2, a3],
    [a3, a2, a1],
  ]) {
    expect(await select(input, { now: at(12) })).toEqual([card(a2)]);
    expect(await select(input, { now: at(16) })).toEqual([card(a2)]);
  }
});

it.each([false, true])(
  '[AC-B1-08m#3] 同时刻按 UUID 字符串最大决胜，上报档=%s',
  async (reported) => {
    const a = attempt(9, { opened_at: at(1), jump_reported_at: reported ? at(2) : null });
    const b = attempt(10, { opened_at: at(1), jump_reported_at: reported ? at(3) : null });
    for (const input of [
      [a, b],
      [b, a],
    ])
      expect(await select(input)).toEqual([card(b)]);
  },
);

it.each([false, true])(
  '[AC-B1-08m#4] 选中项完成后不退回任何旧尝试，上报档=%s',
  async (reported) => {
    const old = attempt(1, { jump_reported_at: reported ? at(2) : null });
    const selected = attempt(3, { jump_reported_at: reported ? at(4) : null });
    const fallback = attempt(6);
    const input = reported ? [old, selected, fallback] : [old, selected];
    expect(
      await select(input, {
        orders: [{ link_id: selected.link_id, attr_at: at(5), source_match: 'exact' }],
      }),
    ).toEqual([]);
  },
);

it('[AC-B1-08m#5] 关闭返回 dismissed=true，不退回更早第一档或较新第二档', async () => {
  const old = attempt(1, { jump_reported_at: at(2) });
  const selected = attempt(3, { jump_reported_at: at(4), dismissed_at: at(5) });
  expect(await select([old, selected, attempt(6)])).toEqual([card(selected, false, true)]);
});

it('[AC-B1-08m#6] share 不参与，每平台一张，结果按 platform 排序', async () => {
  const jd = attempt(1);
  const tb = attempt(2, { platform: 'taobao' });
  const pdd = attempt(3, { platform: 'pdd' });
  const share = attempt(4, { pid_scene: 'share', jump_reported_at: at(5) });
  expect(await select([tb, share, pdd, jd, attempt(0)])).toEqual([card(jd), card(pdd), card(tb)]);
});

it('[AC-B1-08m#7] 没有候选返回空列表，其他 link 的订单不会完成当前卡', async () => {
  expect(await select([])).toEqual([]);
  const a = attempt(1);
  expect(
    await select([a], { orders: [{ link_id: uuid(999), attr_at: at(10), source_match: 'exact' }] }),
  ).toEqual([card(a)]);
});

it('[AC-S1-55#11] 按本人尝试选卡，与创建 link 的设备或当前查看设备无关', async () => {
  // 端口输入只有本人尝试，无设备过滤；上报采信本身由后续埋点任务测试。
  const a = attempt(1, { jump_reported_at: at(2) });
  const b = attempt(3, { jump_reported_at: at(4) });
  expect(await select([a, b])).toEqual([card(b)]);
  expect(await select([b, a])).toEqual([card(b)]);
});
