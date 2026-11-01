// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  PLATFORM_LABEL,
  REASON,
  REASON_MAX,
  ROW_VERSION,
  STATUS_SHOWN,
  activeUser,
  binding,
  createServer,
  userDetail,
  type Action,
  type Platform,
  type Server,
} from './bindings-fixtures.ts';
import {
  FLOW_TIMEOUT,
  HINT,
  REASON_RULE,
  before,
  click,
  closeConfirmations,
  dismissStepUp,
  entry,
  fill,
  isDisabled,
  open,
  openUser,
  passOf,
  perform,
  reasonField,
  reasonHint,
  rowShows,
  ruleText,
  settle,
  settled,
  squash,
  stepUpDialogs,
  submitOf,
  verify,
} from './bindings-helpers.ts';

/** Opens the confirmation of `action` on `platform` and returns its text (spaces removed). */
async function dialogText(platform: Platform, action: Action): Promise<string> {
  const layer = await open(await entry(platform, action));
  reasonField(layer);
  return squash(layer.textContent);
}

/** Closes what is open and checks that nothing was sent. */
async function closedWithoutWrite(server: Server): Promise<void> {
  await closeConfirmations();
  await settled(server);
  expect(stepUpDialogs()).toEqual([]);
  expect(server.requests('POST'), 'opening a confirmation sends nothing').toEqual([]);
}

it(
  '[AC-F1-07jc-DIALOG#1] 【重置授权】确认框说明解除授权、冷却期内不能重新授权、下次购买需重新授权，有必填原因，点开不发请求',
  async () => {
    const server = createServer();
    await openUser(server);
    const text = await dialogText('taobao', 'reset');
    expect(text).toContain(PLATFORM_LABEL.taobao);
    // Task wording (解除授权) or the board's (当前绑定立即释放 / 释放).
    expect(text, 'the binding is released').toMatch(/解除.{0,4}授权|授权.{0,4}解除|释放/);
    expect(text, 'a cooldown or a new authorisation follows').toMatch(/冷却|重新授权/);
    await closedWithoutWrite(server);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jc-DIALOG#2] 【停用返利】确认框说明该平台不再返利、用户购买入口受限，带平台名与必填原因，点开不发请求',
  async () => {
    const server = createServer();
    await openUser(server);
    const text = await dialogText('pdd', 'disable');
    expect(text).toContain(PLATFORM_LABEL.pdd);
    // Task wording (不再返利 / 停止返利) or the board's (只能无返利购买).
    expect(text, 'no rebate on this platform').toMatch(/(?:不再|停止|暂停|不).{0,4}返利|无返利/);
    await closedWithoutWrite(server);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jc-DIALOG#3] 【恢复】确认框：淘宝说明需用户重新授权，拼多多说明立即恢复返利；都有必填原因',
  async () => {
    const server = createServer(
      userDetail([binding('taobao', 'blocked'), binding('pdd', 'blocked')]),
    );
    await openUser(server);
    const taobao = await dialogText('taobao', 'enable');
    expect(taobao).toContain(PLATFORM_LABEL.taobao);
    expect(taobao).toMatch(/重新授权/);
    await closedWithoutWrite(server);
    const pdd = await dialogText('pdd', 'enable');
    expect(pdd).toContain(PLATFORM_LABEL.pdd);
    // Task wording (立即恢复) or the board's (恢复即生效).
    expect(pdd, 'pdd comes back at once').toMatch(
      /(?:立即|即时|马上|立刻|直接).{0,6}恢复|恢复.{0,6}(?:立即|即时|马上|立刻|生效)/,
    );
    await closedWithoutWrite(server);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jc-DIALOG#4] 原因为空、全空白或超过 200 字：前端拦下并提示，或发出后收 20001 [reason] 在原因旁提示；都不改动授权',
  async () => {
    const server = createServer(activeUser(), { writes: ['taobao/disable', 'pdd/disable'] });
    await openUser(server);
    for (const value of ['', '  \n ', '理'.repeat(REASON_MAX + 1)]) {
      const layer = await open(await entry('taobao', 'disable'));
      const field = reasonField(layer);
      // Taken before typing: a hint shown while typing counts as well as one shown on submit.
      const prior = before();
      const writtenBefore = server.writes().length;
      await fill(field, value);
      // An input that refuses the 201st character already keeps the reason within the limit.
      if (value.length > REASON_MAX && field.value.length <= REASON_MAX) {
        await closeConfirmations();
        continue;
      }
      const submit = submitOf(layer);
      if (isDisabled(submit)) {
        // A submit held disabled stops the write; the dialog then states the rule in words (a
        // 「0 / 200」 counter alone does not).
        expect(ruleText(layer), 'the dialog states the reason rule').toMatch(REASON_RULE);
        await click(submit);
        await settle();
        expect(stepUpDialogs()).toEqual([]);
        expect(server.writes(), 'a disabled submit sends nothing').toHaveLength(writtenBefore);
      } else {
        const sent = server.writes().length;
        await click(submit);
        await settle();
        const written = stepUpDialogs().length > 0;
        if (written) {
          await verify(server);
          await waitFor(() => expect(server.writes().length).toBe(sent + 1));
          await settled(server);
        }
        // Stopped before sending: a hint beside the reason or a new notice; refused with 20001
        // [reason]: a hint beside the reason. Either way it says required / too long.
        await waitFor(() =>
          expect(
            reasonHint(prior, layer, !written),
            `a hint about the reason for 「${value.slice(0, 8)}」`,
          ).toMatch(HINT.reason),
        );
        if (!written) expect(server.writes(), 'a refused reason sends nothing').toHaveLength(sent);
      }
      for (const write of server.writes())
        expect(server.answerOf(write), 'a write with a bad reason is refused').toBe(20001);
      expect(server.row('taobao')).toMatchObject({ status: 'active', row_version: 7 });
      await rowShows('taobao', STATUS_SHOWN.active);
      await closeConfirmations();
    }
    // Exactly 200 characters go through; surrounding blanks are trimmed before sending.
    const limit = await perform(server, 'taobao', 'disable', '理'.repeat(REASON_MAX));
    expect(limit.write.body).toEqual({
      reason: '理'.repeat(REASON_MAX),
      expected_row_version: ROW_VERSION.taobao,
    });
    await closeConfirmations();
    const trimmed = await perform(server, 'pdd', 'disable', `  ${REASON} \n`);
    expect(trimmed.write.body).toEqual({ reason: REASON, expected_row_version: ROW_VERSION.pdd });
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jc-DIALOG#5] 取消确认框或取消动态码都不发写请求、授权不变；再次操作重新确认并验证后才发',
  async () => {
    const server = createServer(activeUser(), { writes: ['taobao/reset'] });
    await openUser(server);
    await open(await entry('taobao', 'reset'));
    await closedWithoutWrite(server);

    const layer = await open(await entry('taobao', 'reset'));
    await fill(reasonField(layer), REASON);
    await click(submitOf(layer));
    await dismissStepUp();
    await settled(server);
    expect(server.requests('POST'), 'no write after cancelling the step-up').toEqual([]);
    await rowShows('taobao', STATUS_SHOWN.active);
    await closeConfirmations();

    const { write } = await perform(server, 'taobao', 'reset', REASON);
    expect(server.verifies()).toHaveLength(1);
    expect(passOf(write)).toBe(server.issued[0]);
    await rowShows('taobao', STATUS_SHOWN.released);
  },
  FLOW_TIMEOUT,
);
