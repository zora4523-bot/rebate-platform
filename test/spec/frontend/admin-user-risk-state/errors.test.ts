// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  DETAIL,
  LATER,
  REASON,
  RISK_PATH,
  ROW,
  createServer,
  failure,
  userDetail,
  userIn,
  type RiskAction,
  type RiskState,
  type Server,
} from './risk-fixtures.ts';
import {
  ANY_ENTRY,
  FLOW_TIMEOUT,
  HINT,
  announce,
  announceSuccess,
  closeConfirmations,
  confirmations,
  expectBody,
  expectEntries,
  expectNoSuccess,
  freshText,
  headerShows,
  main,
  nameOf,
  openUser,
  passOf,
  perform,
  readAgain,
  reasonHint,
  settled,
  timeHint,
  usable,
  type RiskForm,
} from './risk-helpers.ts';

const FREEZE: RiskForm = { category: 'abnormal_trade', period: 'none', reason: REASON };
const BAN: RiskForm = { category: 'malicious_rights', reason: REASON };

/** The risk state is as it was (server and title row) and the entries are still offered. */
async function unchanged(
  server: Server,
  state: RiskState,
  rowVersion: number | null,
  entries: readonly RiskAction[],
  optional: readonly RiskAction[] = [],
): Promise<void> {
  expect(server.risk()).toMatchObject({ state, row_version: rowVersion });
  await headerShows(state);
  await expectEntries(entries, optional);
}

it(
  '[AC-F1-07jd-ERROR#1] 20902（data.resource=user_risk_state）：提示状态已变化并重拉详情；不自动重发，再操作时带重拉后的 row_version 并成功',
  async () => {
    const server = createServer(userIn('normal'), { writes: ['freeze'] });
    server.once('PUT', RISK_PATH, () => {
      server.changeElsewhere({ reason: '另一位运营已复核' });
      return failure(20902, { resource: 'user_risk_state' });
    });
    await openUser(server);
    const { write, prior } = await perform(server, 'freeze', FREEZE);
    expectBody(
      write,
      {
        action: 'freeze',
        reason_category: 'abnormal_trade',
        reason: REASON,
        expected_row_version: ROW.normal,
      },
      'none',
    );
    await announce(prior, HINT.changed);
    await readAgain(server, write);
    expectNoSuccess(prior);
    expect(server.writes(), 'no automatic resend').toHaveLength(1);
    await headerShows('normal');
    await closeConfirmations();

    const retry = await perform(server, 'freeze', FREEZE);
    expectBody(
      retry.write,
      {
        action: 'freeze',
        reason_category: 'abnormal_trade',
        reason: REASON,
        expected_row_version: ROW.normal + 1,
      },
      'none',
    );
    expect(passOf(retry.write)).toBe(server.issued[1]);
    expect(server.answerOf(retry.write)).toBe(0);
    await announceSuccess(retry.prior, 'freeze');
    await headerShows('frozen');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jd-ERROR#2] 详情无风控行时带 null，期间别人已建行（被冻结）→ 20902：重拉后标题行显示已冻结、按钮随之变化，再封禁带 row_version 0 成功',
  async () => {
    const server = createServer(userDetail(), { writes: ['ban'] });
    await openUser(server);
    await expectEntries(['freeze', 'ban']);
    // Someone else freezes the user while this page still shows no row.
    server.changeElsewhere({
      state: 'frozen',
      reason_category: 'other',
      reason: '另一位运营已处理',
    });
    const { write, prior } = await perform(server, 'ban', BAN);
    expectBody(write, {
      action: 'ban',
      reason_category: 'malicious_rights',
      reason: REASON,
      expected_row_version: null,
    });
    expect(server.answerOf(write)).toBe(20902);
    await announce(prior, HINT.changed);
    await readAgain(server, write);
    expectNoSuccess(prior);
    await headerShows('frozen');
    await expectEntries(['unfreeze', 'ban'], ['freeze']);
    await closeConfirmations();

    const retry = await perform(server, 'ban', BAN);
    expectBody(retry.write, {
      action: 'ban',
      reason_category: 'malicious_rights',
      reason: REASON,
      expected_row_version: 0,
    });
    expect(server.answerOf(retry.write)).toBe(0);
    await announceSuccess(retry.prior, 'ban');
    await headerShows('banned');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jd-ERROR#3] 20902 之后重拉详情失败：提示未能刷新，不显示成功、不自动重发',
  async () => {
    const server = createServer(userIn('frozen'), { writes: ['unfreeze'] });
    server.once('PUT', RISK_PATH, () => {
      server.changeElsewhere({ reason: '另一位运营已复核' });
      // The read after the conflict fails (registered here: the opening read must succeed).
      server.once('GET', DETAIL, () => Promise.reject(new TypeError('offline')));
      return failure(20902, { resource: 'user_risk_state' });
    });
    await openUser(server);
    const { write, prior } = await perform(server, 'unfreeze', { reason: REASON });
    await readAgain(server, write);
    await waitFor(() =>
      expect(freshText(prior), 'a could-not-refresh notice').toMatch(HINT.refreshFailed),
    );
    expectNoSuccess(prior);
    expect(server.writes(), 'no automatic resend').toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jd-ERROR#4] 44004：提示当前状态不能做此操作并重拉详情；用户已转申诉中时标题行显示申诉中、不再有可用按钮',
  async () => {
    const server = createServer(userIn('frozen'), { writes: ['unfreeze'] });
    server.once('PUT', RISK_PATH, () => {
      server.changeElsewhere({ state: 'appealing' });
      return failure(44004);
    });
    await openUser(server);
    const { write, prior } = await perform(server, 'unfreeze', { reason: REASON });
    await announce(prior, HINT.notAllowed);
    await readAgain(server, write);
    expectNoSuccess(prior);
    await headerShows('appealing');
    await waitFor(() =>
      expect(usable(main(), ANY_ENTRY).map(nameOf), 'no usable risk entry').toEqual([]),
    );
    expect(server.writes(), 'no automatic resend').toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jd-ERROR#5] 20001 [reason]：在原因旁说明规则（对话框仍在、已填内容保留），不显示成功、状态不变',
  async () => {
    const server = createServer(userIn('frozen'), { writes: ['unfreeze'] });
    server.once('PUT', RISK_PATH, () => failure(20001, { fields: ['reason'] }));
    await openUser(server);
    const { prior } = await perform(server, 'unfreeze', { reason: REASON });
    await waitFor(() => expect(confirmations(), 'the dialog is still open').toHaveLength(1));
    await waitFor(() =>
      expect(reasonHint(prior, false), 'a hint beside the reason').toMatch(HINT.reason),
    );
    expectNoSuccess(prior);
    await closeConfirmations();
    await unchanged(server, 'frozen', ROW.frozen, ['unfreeze', 'ban'], ['freeze']);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jd-ERROR#6] 20001 [frozen_until]：在期限旁提示（对话框仍在），不显示成功、状态不变',
  async () => {
    const server = createServer(userIn('normal'), { writes: ['freeze'] });
    server.once('PUT', RISK_PATH, () => failure(20001, { fields: ['frozen_until'] }));
    await openUser(server);
    const { write, prior } = await perform(server, 'freeze', { ...FREEZE, period: LATER });
    expectBody(
      write,
      {
        action: 'freeze',
        reason_category: 'abnormal_trade',
        reason: REASON,
        expected_row_version: ROW.normal,
      },
      LATER,
    );
    await waitFor(() => expect(confirmations(), 'the dialog is still open').toHaveLength(1));
    await waitFor(() =>
      expect(timeHint(prior, false), 'a hint beside the freeze end').toMatch(HINT.time),
    );
    expectNoSuccess(prior);
    await closeConfirmations();
    await unchanged(server, 'normal', ROW.normal, ['freeze', 'ban']);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jd-ERROR#7] 10403：提示没有权限，不显示成功、状态不变',
  async () => {
    const server = createServer(userIn('normal'), { writes: ['ban'] });
    server.once('PUT', RISK_PATH, () => failure(10403, { reason: 'admin_permission_denied' }));
    await openUser(server);
    const { prior } = await perform(server, 'ban', BAN);
    await announce(prior, HINT.forbidden);
    await settled(server);
    expectNoSuccess(prior);
    expect(server.writes()).toHaveLength(1);
    await closeConfirmations();
    await unchanged(server, 'normal', ROW.normal, ['freeze', 'ban']);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jd-ERROR#8] 网络失败：提示失败、不显示成功、不自动重发，状态不变',
  async () => {
    const server = createServer(userIn('banned'), { writes: ['unban'] });
    server.once('PUT', RISK_PATH, () => Promise.reject(new TypeError('offline')));
    await openUser(server);
    const { prior } = await perform(server, 'unban', { reason: REASON });
    await announce(prior, HINT.failed);
    await settled(server);
    expectNoSuccess(prior);
    expect(server.writes(), 'no automatic resend').toHaveLength(1);
    await closeConfirmations();
    await unchanged(server, 'banned', ROW.banned, ['unban']);
  },
  FLOW_TIMEOUT,
);
