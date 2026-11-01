// @vitest-environment jsdom
import { act, fireEvent, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  LATER,
  OTP,
  REASON,
  RISK_PATH,
  ROW,
  createServer,
  failure,
  userDetail,
  userIn,
} from './risk-fixtures.ts';
import {
  FLOW_TIMEOUT,
  FREEZE_ONLY,
  BAN_ONLY,
  announceSuccess,
  closeConfirmations,
  confirmation,
  expectBody,
  expectEntries,
  expectWrite,
  fillForm,
  headerShows,
  openDialog,
  openUser,
  passOf,
  perform,
  settle,
  settled,
  stepUp,
  stepUpDialogs,
  submitOf,
  click,
  verify,
} from './risk-helpers.ts';

it(
  '[AC-F1-07jd-WRITE#1] 无风控行的正常用户【冻结】不定期：确认 → 动态码 → 一次 PUT risk-state，带令牌、无 Idempotency-Key，body 为 freeze + 类别 + 原因 + expected_row_version null（frozen_until 为 null 或不带）；提示冻结成功，标题行变已冻结、按钮换成【解冻】【封禁】',
  async () => {
    const server = createServer(userDetail(), { writes: ['freeze'] });
    const { directFetch } = await openUser(server);
    const { write, prior } = await perform(server, 'freeze', {
      category: 'abnormal_trade',
      period: 'none',
      reason: REASON,
    });
    expectWrite(server, write);
    expectBody(
      write,
      {
        action: 'freeze',
        reason_category: 'abnormal_trade',
        reason: REASON,
        expected_row_version: null,
      },
      'none',
    );
    expect(passOf(write)).toBe(server.issued[0]);
    expect(server.verifies().map((one) => one.body)).toEqual([{ tier: 'totp', code: OTP }]);
    expect(server.answerOf(write)).toBe(0);
    await announceSuccess(prior, 'freeze');
    await headerShows('frozen');
    await expectEntries(['unfreeze', 'ban'], ['freeze']);
    expect(server.writes()).toHaveLength(1);
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jd-WRITE#2] 有风控行的正常用户【冻结】到期：frozen_until 为所选时刻（ISO 带时区），expected_row_version 取详情 risk.row_version；只持 risk.freeze 也能做',
  async () => {
    const server = createServer(userIn('normal'), { writes: ['freeze'] });
    await openUser(server, FREEZE_ONLY);
    const { write, prior } = await perform(server, 'freeze', {
      category: 'fraud_invite',
      period: LATER,
      reason: REASON,
    });
    expectWrite(server, write);
    expectBody(
      write,
      {
        action: 'freeze',
        reason_category: 'fraud_invite',
        reason: REASON,
        expected_row_version: ROW.normal,
      },
      LATER,
    );
    expect(server.answerOf(write)).toBe(0);
    await announceSuccess(prior, 'freeze');
    await headerShows('frozen');
    await expectEntries(['unfreeze'], ['freeze']);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jd-WRITE#3] 已冻结用户【解冻】：body 恰为 {action: unfreeze, reason, expected_row_version}（不带原因类别与期限）；提示解冻成功，标题行变正常、按钮回到【冻结】【封禁】',
  async () => {
    const server = createServer(userIn('frozen'), { writes: ['unfreeze'] });
    await openUser(server);
    const { write, prior } = await perform(server, 'unfreeze', { reason: REASON });
    expectWrite(server, write);
    expectBody(write, { action: 'unfreeze', reason: REASON, expected_row_version: ROW.frozen });
    expect(server.answerOf(write)).toBe(0);
    await announceSuccess(prior, 'unfreeze');
    await headerShows('normal');
    await expectEntries(['freeze', 'ban']);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jd-WRITE#4] 正常用户【封禁】：body 恰为 {action: ban, reason_category, reason, expected_row_version}（不带 frozen_until）；提示封禁成功，标题行变已封禁、只剩【解封】',
  async () => {
    const server = createServer(userIn('normal'), { writes: ['ban'] });
    await openUser(server);
    const { write, prior } = await perform(server, 'ban', {
      category: 'malicious_rights',
      reason: REASON,
    });
    expectWrite(server, write);
    expectBody(write, {
      action: 'ban',
      reason_category: 'malicious_rights',
      reason: REASON,
      expected_row_version: ROW.normal,
    });
    expect(server.answerOf(write)).toBe(0);
    await announceSuccess(prior, 'ban');
    await headerShows('banned');
    await expectEntries(['unban']);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jd-WRITE#5] 已封禁用户【解封】（只持 risk.ban）：body 恰为 {action: unban, reason, expected_row_version}；提示解封成功，标题行变正常、按钮回到【封禁】',
  async () => {
    const server = createServer(userIn('banned'), { writes: ['unban'] });
    await openUser(server, BAN_ONLY);
    const { write, prior } = await perform(server, 'unban', { reason: REASON });
    expectWrite(server, write);
    expectBody(write, { action: 'unban', reason: REASON, expected_row_version: ROW.banned });
    expect(server.answerOf(write)).toBe(0);
    await announceSuccess(prior, 'unban');
    await headerShows('normal');
    await expectEntries(['ban']);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jd-WRITE#6] 连续两次操作（先冻结再解冻）各弹一次动态码、令牌不同；第二次带第一次之后的 row_version（无风控行时从 null 到 0）',
  async () => {
    const server = createServer(userDetail(), { writes: ['freeze', 'unfreeze'] });
    await openUser(server);
    const first = await perform(server, 'freeze', {
      category: 'account_security',
      period: 'none',
      reason: REASON,
    });
    await headerShows('frozen');
    await closeConfirmations();
    // perform() waits for a second step-up dialog and checks that nothing left before it.
    const second = await perform(server, 'unfreeze', { reason: REASON });
    expect(server.verifies()).toHaveLength(2);
    expect(passOf(first.write)).toBe(server.issued[0]);
    expect(passOf(second.write)).toBe(server.issued[1]);
    expect(passOf(second.write)).not.toBe(passOf(first.write));
    expect(server.log.indexOf(second.write)).toBeGreaterThan(
      server.log.indexOf(server.verifies()[1]!),
    );
    expectBody(second.write, { action: 'unfreeze', reason: REASON, expected_row_version: 0 });
    expect(server.answerOf(second.write)).toBe(0);
    await headerShows('normal');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jd-WRITE#7] 连点确认与【验证并继续】、请求在途时再点：只弹一次动态码、只验证一次、只发一次 PUT',
  async () => {
    const server = createServer(userIn('normal'), { writes: ['ban'] });
    await openUser(server);
    const release = server.hold('PUT', RISK_PATH);
    try {
      await openDialog('ban');
      await fillForm({ category: 'other', reason: REASON });
      const submit = submitOf(await confirmation());
      await act(async () => {
        fireEvent.click(submit);
        fireEvent.click(submit);
      });
      await stepUp();
      await verify(server, true);
      await waitFor(() => expect(server.writes()).toHaveLength(1));
      await settle();
      if (submit.isConnected) {
        await click(submit);
        await click(submit);
      }
      await settle();
      expect(stepUpDialogs(), 'no second step-up while the write is in flight').toEqual([]);
      expect(server.writes()).toHaveLength(1);
    } finally {
      release();
    }
    await settled(server);
    expect(server.writes()).toHaveLength(1);
    expect(server.verifies()).toHaveLength(1);
    await headerShows('banned');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jd-WRITE#8] PUT 回 10003：重新弹动态码，验证后用新令牌、原请求体再发一次，之后成功',
  async () => {
    const server = createServer(userIn('frozen'), { writes: ['unfreeze'] });
    server.once('PUT', RISK_PATH, () => failure(10003, { tier: 'totp' }));
    await openUser(server);
    const { prior } = await perform(server, 'unfreeze', { reason: REASON });
    await stepUp();
    await settled(server);
    expect(server.writes()).toHaveLength(1);
    expect(server.verifies()).toHaveLength(1);
    await verify(server);
    await waitFor(() => expect(server.writes()).toHaveLength(2));
    await settled(server);
    expect(server.writes().map((one) => passOf(one))).toEqual([server.issued[0], server.issued[1]]);
    const body = { action: 'unfreeze', reason: REASON, expected_row_version: ROW.frozen };
    expect(server.writes().map((one) => one.body)).toEqual([body, body]);
    expect(server.writes().map((one) => one.headers.has('Idempotency-Key'))).toEqual([
      false,
      false,
    ]);
    await announceSuccess(prior, 'unfreeze');
    await headerShows('normal');
  },
  FLOW_TIMEOUT,
);
