// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  CATEGORIES,
  EARLIER,
  REASON,
  REASON_MAX,
  ROW,
  createServer,
  hasZone,
  userDetail,
  userIn,
  type RiskAction,
  type Server,
} from './risk-fixtures.ts';
import {
  FLOW_TIMEOUT,
  HINT,
  PERIOD_NONE,
  PERIOD_UNTIL,
  REASON_RULE,
  before,
  categoryRadios,
  chooseCategory,
  choosePeriod,
  click,
  closeConfirmations,
  confirmation,
  dialogHint,
  dismissStepUp,
  expectBody,
  expectNoSuccess,
  fill,
  headerShows,
  isDisabled,
  offeredCategories,
  openDialog,
  openUser,
  passOf,
  perform,
  periodRadios,
  reasonField,
  reasonHint,
  ruleText,
  selectsOf,
  settle,
  settled,
  stepUpDialogs,
  submitOf,
  timeFields,
  timeHint,
  tryTime,
  unmountAll,
  verify,
} from './risk-helpers.ts';

/** Closes what is open and checks that nothing was sent. */
async function closedWithoutWrite(server: Server): Promise<void> {
  await closeConfirmations();
  await settled(server);
  expect(stepUpDialogs()).toEqual([]);
  expect(server.nonReads(), 'opening a dialog sends nothing').toEqual([]);
}

/** The dialog of `action` offers the reason only: no category, no period. */
async function reasonOnly(server: Server, action: RiskAction): Promise<void> {
  const layer = await openDialog(action);
  reasonField(layer);
  expect(categoryRadios(layer), `${action}: no category radios`).toEqual([]);
  expect(selectsOf(layer), `${action}: no select`).toEqual([]);
  expect(periodRadios(layer), `${action}: no period`).toEqual([]);
  expect(timeFields(layer), `${action}: no freeze end`).toEqual([]);
  await closedWithoutWrite(server);
}

it(
  '[AC-F1-07jd-DIALOG#1] 【冻结】对话框：必选原因类别（五类，显示字典中文名或编码）、期限（不定期，或选一个时间）、必填原因；点开不发请求',
  async () => {
    const server = createServer(userDetail());
    await openUser(server);
    const layer = await openDialog('freeze');
    reasonField(layer);
    expect(await offeredCategories(), 'every risk_reason_category').toEqual([...CATEGORIES]);
    // A freeze without end is offered in words (the board: 「不设期限（人工解冻）」); the 封禁
    // choice of a dialog that does both (「…不设期限」) does not count.
    expect(ruleText(await confirmation(), true), 'a freeze without end').toMatch(PERIOD_NONE);
    const until = periodRadios(await confirmation()).filter((node) => {
      const label = node.closest('label')?.textContent ?? '';
      return PERIOD_UNTIL.test(label) && !PERIOD_NONE.test(label);
    });
    if (until.length > 0) await click(until[0]!);
    expect(timeFields(await confirmation()), 'one input for the freeze end').toHaveLength(1);
    await closedWithoutWrite(server);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jd-DIALOG#2] 【封禁】对话框：同冻结去掉期限——必选原因类别（五类）与必填原因，没有期限选择或时间输入；点开不发请求',
  async () => {
    const server = createServer(userIn('frozen'));
    await openUser(server);
    const layer = await openDialog('ban');
    reasonField(layer);
    expect(periodRadios(layer), 'no period choice').toEqual([]);
    expect(timeFields(layer), 'no freeze end').toEqual([]);
    expect(await offeredCategories(), 'every risk_reason_category').toEqual([...CATEGORIES]);
    await closedWithoutWrite(server);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jd-DIALOG#3] 【解冻】【解封】对话框只填原因：不显示原因类别的选择，也没有期限',
  async () => {
    const frozen = createServer(userIn('frozen'));
    await openUser(frozen);
    await reasonOnly(frozen, 'unfreeze');
    unmountAll();
    const banned = createServer(userIn('banned'));
    await openUser(banned);
    await reasonOnly(banned, 'unban');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jd-DIALOG#4] 原因为空或超过 200 字：前端拦下并说明规则，或发出后收 20001 [reason] 在原因旁说明规则；全空白原因必须前端拦下、说明规则、不发 PUT；都不改风控状态；恰 200 字可提交，首尾空白去掉后发送',
  async () => {
    const server = createServer(userIn('frozen'), { writes: ['unfreeze', 'freeze'] });
    await openUser(server);
    for (const value of ['', '  \n ', '理'.repeat(REASON_MAX + 1)]) {
      // The contract does not trim, so the server takes blanks: only the page can stop them.
      const blank = value !== '' && value.trim() === '';
      await openDialog('unfreeze');
      // Taken before typing: a hint shown while typing counts as well as one shown on submit.
      const prior = before();
      const writtenBefore = server.writes().length;
      await fill(reasonField(await confirmation()), value);
      // An input that refuses the 201st character already keeps the reason within the limit.
      if (
        value.length > REASON_MAX &&
        reasonField(await confirmation()).value.length <= REASON_MAX
      ) {
        await closeConfirmations();
        continue;
      }
      const submit = submitOf(await confirmation());
      if (isDisabled(submit)) {
        // A submit held disabled stops the write; the dialog then states the rule in words.
        expect(ruleText(await confirmation()), 'the dialog states the reason rule').toMatch(
          REASON_RULE,
        );
        await click(submit);
        await settle();
        expect(stepUpDialogs()).toEqual([]);
        expect(server.writes(), 'a disabled submit sends nothing').toHaveLength(writtenBefore);
      } else {
        const sent = server.writes().length;
        await click(submit);
        await settle();
        const written = stepUpDialogs().length > 0;
        if (blank)
          expect(written, 'a blank reason is stopped before the step-up and the PUT').toBe(false);
        if (written) {
          await verify(server);
          await waitFor(() => expect(server.writes().length).toBe(sent + 1));
          await settled(server);
        }
        // Stopped before sending: a hint beside the reason or a new notice; refused with 20001
        // [reason]: a hint beside the reason in the dialog. Either way it states the rule.
        await waitFor(() =>
          expect(
            reasonHint(prior, !written),
            `a hint about the reason for 「${value.slice(0, 8)}」`,
          ).toMatch(HINT.reason),
        );
        if (!written) expect(server.writes(), 'a refused reason sends nothing').toHaveLength(sent);
      }
      if (blank) expect(server.writes(), 'a blank reason sends no PUT').toHaveLength(writtenBefore);
      for (const write of server.writes())
        expect(server.answerOf(write), 'a write with a bad reason is refused').toBe(20001);
      expect(server.risk()).toMatchObject({ state: 'frozen', row_version: ROW.frozen });
      await headerShows('frozen');
      await closeConfirmations();
    }
    // Exactly 200 characters go through.
    const limit = await perform(server, 'unfreeze', { reason: '理'.repeat(REASON_MAX) });
    expectBody(limit.write, {
      action: 'unfreeze',
      reason: '理'.repeat(REASON_MAX),
      expected_row_version: ROW.frozen,
    });
    await headerShows('normal');
    await closeConfirmations();
    // Surrounding blanks are trimmed before sending.
    const trimmed = await perform(server, 'freeze', {
      category: 'abnormal_trade',
      period: 'none',
      reason: `  ${REASON} \n`,
    });
    expectBody(
      trimmed.write,
      {
        action: 'freeze',
        reason_category: 'abnormal_trade',
        reason: REASON,
        expected_row_version: ROW.frozen + 1,
      },
      'none',
    );
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jd-DIALOG#5] 【冻结】【封禁】不选原因类别：前端拦下并提示选择类别，或发出后收 20001 [reason_category] 并提示；风控状态不变',
  async () => {
    const server = createServer(userDetail(), { writes: ['freeze', 'ban'] });
    await openUser(server);
    for (const action of ['freeze', 'ban'] as const) {
      await openDialog(action);
      if (action === 'freeze') await choosePeriod('none');
      await fill(reasonField(await confirmation()), REASON);
      const prior = before();
      const sent = server.writes().length;
      const submit = submitOf(await confirmation());
      if (isDisabled(submit)) {
        expect(ruleText(await confirmation()), 'the dialog says a category is required').toMatch(
          /(?:请选择|必选).{0,8}类别|类别.{0,12}(?:必选|必填|请选择)/,
        );
        await click(submit);
        await settle();
        expect(stepUpDialogs()).toEqual([]);
        expect(server.writes()).toHaveLength(sent);
      } else {
        await click(submit);
        await settle();
        const written = stepUpDialogs().length > 0;
        if (written) {
          await verify(server);
          await waitFor(() => expect(server.writes().length).toBe(sent + 1));
          await settled(server);
          expect(server.answerOf(server.writes().at(-1)!), 'no category is refused').toBe(20001);
        }
        await waitFor(() =>
          expect(dialogHint(prior, !written), `${action}: a hint about the category`).toMatch(
            HINT.category,
          ),
        );
        if (!written) expect(server.writes(), 'nothing sent').toHaveLength(sent);
      }
      expect(server.risk()).toMatchObject({ state: 'normal', row_version: null });
      expectNoSuccess(prior);
      await headerShows('normal');
      await closeConfirmations();
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jd-DIALOG#6] 冻结期限早于现在：前端拦下并提示，或带上该时间发出、收 20001 [frozen_until] 后在期限旁提示；不会改成不定期冻结，风控状态不变',
  async () => {
    const server = createServer(userDetail(), { writes: ['freeze'] });
    await openUser(server);
    await openDialog('freeze');
    await chooseCategory('abnormal_trade');
    const until = periodRadios(await confirmation()).filter((node) => {
      const label = node.closest('label')?.textContent ?? '';
      return PERIOD_UNTIL.test(label) && !PERIOD_NONE.test(label);
    });
    if (until.length > 0) await click(until[0]!);
    // Taken before the time is entered: a hint shown while picking counts too.
    const prior = before();
    await tryTime(EARLIER);
    await fill(reasonField(await confirmation()), REASON);
    const sent = server.writes().length;
    const submit = submitOf(await confirmation());
    if (isDisabled(submit)) {
      expect(ruleText(await confirmation()), 'the dialog says the end must be later').toMatch(
        /晚于|之后|未来|早于|过去|已过|请选择.{0,6}(?:时间|日期)/,
      );
      await click(submit);
      await settle();
      expect(stepUpDialogs()).toEqual([]);
      expect(server.writes()).toHaveLength(sent);
    } else {
      await click(submit);
      await settle();
      const written = stepUpDialogs().length > 0;
      if (written) {
        await verify(server);
        await waitFor(() => expect(server.writes().length).toBe(sent + 1));
        await settled(server);
        const write = server.writes().at(-1)!;
        const body = write.body as Record<string, unknown>;
        expect(hasZone(body['frozen_until']), 'the chosen end is sent, not dropped').toBe(true);
        expect(server.answerOf(write), 'an end that has passed is refused').toBe(20001);
      }
      await waitFor(() =>
        expect(timeHint(prior, !written), 'a hint about the freeze end').toMatch(HINT.time),
      );
      if (!written) expect(server.writes(), 'nothing sent').toHaveLength(sent);
    }
    expect(server.risk()).toMatchObject({ state: 'normal', row_version: null });
    expectNoSuccess(prior);
    await headerShows('normal');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jd-DIALOG#7] 取消对话框或取消动态码都不发写请求、状态不变；再次操作确认并验证后才发',
  async () => {
    const server = createServer(userIn('frozen'), { writes: ['unfreeze'] });
    await openUser(server);
    await openDialog('unfreeze');
    await closedWithoutWrite(server);

    await openDialog('unfreeze');
    await fill(reasonField(await confirmation()), REASON);
    await click(submitOf(await confirmation()));
    await dismissStepUp();
    await settled(server);
    expect(server.writes(), 'no write after cancelling the step-up').toEqual([]);
    await headerShows('frozen');
    await closeConfirmations();

    const { write } = await perform(server, 'unfreeze', { reason: REASON });
    expect(server.verifies()).toHaveLength(1);
    expect(passOf(write)).toBe(server.issued[0]);
    await headerShows('normal');
  },
  FLOW_TIMEOUT,
);
