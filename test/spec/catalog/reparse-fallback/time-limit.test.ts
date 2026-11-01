// B1-05y: 重新解析步骤 3「单次超时 3 秒」with the fallback. Before the fallback one re-parse was one
// union call, so 单次 meant both. Now one re-parse can be two calls, and the 3 s stay one limit of
// that re-parse, shared by steps ① and ②: not 3 s for each. The limit at 491308b8c (withinLimit)
// gave each call its own 3 s, so a shared limit is new behaviour. Real timers, as in B1-05w: these
// cases do not depend on how the implementation measures the time.
import { expect, it } from 'vitest';
import { HANG_LIMIT_MS, NEW_RAW, askedRaws, hang, waitedOut } from '../detail-reparse/kit.ts';
import { slowPage, slowlyUnimplemented, unimplementedLinkFixture } from './kit.ts';

/** Long enough for the real 3 s, a little of the fallback after it and the slack around. */
const TIMEOUT_CASE_MS = HANG_LIMIT_MS + 5000;
/** Step ① takes this long: with 3 s of its own, step ② would end past HANG_LIMIT_MS. */
const SLOW_STEP_MS = 2000;

it(
  '[B1-05y#20][BR-PROD-05] 步骤 3：resolveLink 未实现、回落的标题搜索不返回 → 3 秒超时，按暂时失败 50401',
  async () => {
    const f = unimplementedLinkFixture();
    f.searchItems.mockImplementation(hang);

    const ended = await waitedOut(() => f.run());

    expect(ended).toMatchObject({ state: 'rejected', error: { code: 50401 } });
    expect(f.searchItems).toHaveBeenCalledTimes(1);
    expect(f.getItem).not.toHaveBeenCalled();
    expect(f.registerProductRef).not.toHaveBeenCalled();
  },
  TIMEOUT_CASE_MS,
);

it(
  '[B1-05y#21][BR-PROD-05] 步骤 3：两步共用 3 秒：第①步用掉 2 秒才答未实现、标题搜索不返回 → 从重解析开始算满 3 秒就结束，不再给第②步 3 秒',
  async () => {
    const f = unimplementedLinkFixture();
    f.resolveLink.mockImplementation(slowlyUnimplemented(SLOW_STEP_MS));
    f.searchItems.mockImplementation(hang);

    const ended = await waitedOut(() => f.run());

    expect(ended).toMatchObject({ state: 'rejected', error: { code: 50401 } });
    expect(f.searchItems).toHaveBeenCalledTimes(1);
    expect(f.getItem).not.toHaveBeenCalled();
  },
  TIMEOUT_CASE_MS,
);

it(
  '[B1-05y#22][BR-PROD-05] 步骤 3：两步合计超 3 秒：各 2 秒、单看都没超 → 仍按暂时失败 50401，迟到的答复不写 product_refs、不出卡',
  async () => {
    const f = unimplementedLinkFixture();
    f.resolveLink.mockImplementation(slowlyUnimplemented(SLOW_STEP_MS));
    f.searchItems.mockImplementation(slowPage(SLOW_STEP_MS));

    const ended = await waitedOut(() => f.run());

    expect(ended).toMatchObject({ state: 'rejected', error: { code: 50401 } });
    expect(f.getItem).not.toHaveBeenCalled();
    expect(f.registerProductRef).not.toHaveBeenCalled();
    expect(f.rows).toEqual([]);
  },
  TIMEOUT_CASE_MS,
);

it(
  '[B1-05y#23][BR-PROD-05] 步骤 3：两步合计没超 3 秒：回落照常出卡，第①步没有吃掉第②步剩下的时间',
  async () => {
    const f = unimplementedLinkFixture();
    f.resolveLink.mockImplementation(slowlyUnimplemented(800));
    f.searchItems.mockImplementation(slowPage(1200));

    const card = await f.run();

    expect(card).toMatchObject({ stale: false, final_price_fen: 2990 });
    expect(askedRaws(f.fake)).toEqual([NEW_RAW]);
  },
  TIMEOUT_CASE_MS,
);
