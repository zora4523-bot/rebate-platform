// @vitest-environment jsdom
import { act, fireEvent, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  OTP,
  REASON,
  ROW_VERSION,
  STATUS_SHOWN,
  activeUser,
  binding,
  bindingPath,
  createServer,
  failure,
  userDetail,
  type RequestLog,
  type Server,
} from './bindings-fixtures.ts';
import {
  FLOW_TIMEOUT,
  HINT,
  announce,
  click,
  closeConfirmations,
  entriesOf,
  entry,
  fill,
  open,
  openUser,
  passOf,
  perform,
  reasonField,
  rowShows,
  settle,
  settled,
  stepUp,
  stepUpDialogs,
  submitOf,
  verify,
} from './bindings-helpers.ts';

/** The write carried one fresh step-up grant, no Idempotency-Key, no query and exactly `body`. */
function expectWrite(server: Server, write: RequestLog, path: string, body: unknown): void {
  expect(write.method).toBe('POST');
  expect(write.path).toBe(path);
  expect(write.query).toEqual({});
  expect(write.body).toEqual(body);
  expect(write.headers.has('Idempotency-Key'), 'no Idempotency-Key').toBe(false);
  expect(passOf(write), 'X-Step-Up-Token').not.toBeNull();
  expect(server.issued).toContain(passOf(write));
  const sent = server.log.indexOf(write);
  const verified = server.log.findIndex(
    (one) => one.method === 'POST' && one.path === '/admin/v1/auth/step-up',
  );
  expect(verified, 'a step-up before the write').toBeGreaterThanOrEqual(0);
  expect(sent).toBeGreaterThan(verified);
}

it(
  '[AC-F1-07jc-WRITE#1] 淘宝【重置授权】：确认 → 动态码 → 一次 POST …/taobao/reset，带令牌、无 Idempotency-Key、body 恰为原因与该行 row_version；成功提示，该行变已解除且无入口',
  async () => {
    const server = createServer(activeUser(), { writes: ['taobao/reset'] });
    const { directFetch } = await openUser(server);
    const { write, prior } = await perform(server, 'taobao', 'reset', REASON);
    expectWrite(server, write, bindingPath('taobao', 'reset'), {
      reason: REASON,
      expected_row_version: ROW_VERSION.taobao,
    });
    expect(passOf(write)).toBe(server.issued[0]);
    expect(server.verifies().map((one) => one.body)).toEqual([{ tier: 'totp', code: OTP }]);
    await announce(prior, HINT.reset);
    await rowShows('taobao', STATUS_SHOWN.released);
    await waitFor(() => expect(entriesOf('taobao'), 'a released row has no entry').toEqual([]));
    await rowShows('pdd', STATUS_SHOWN.active);
    expect(entriesOf('pdd')).toEqual(['disable']);
    expect(server.writes()).toHaveLength(1);
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jc-WRITE#2] 拼多多【停用返利】：POST …/pdd/disable 取该行 row_version；成功提示，该行变已停用，入口换成【恢复】',
  async () => {
    const server = createServer(activeUser(), { writes: ['pdd/disable'] });
    await openUser(server);
    const { write, prior } = await perform(server, 'pdd', 'disable', REASON);
    expectWrite(server, write, bindingPath('pdd', 'disable'), {
      reason: REASON,
      expected_row_version: ROW_VERSION.pdd,
    });
    await announce(prior, HINT.disable);
    await rowShows('pdd', STATUS_SHOWN.blocked);
    await waitFor(() => expect(entriesOf('pdd')).toEqual(['enable']));
    expect(entriesOf('taobao')).toEqual(['reset', 'disable']);
    expect(server.writes()).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jc-WRITE#3] 【恢复】：拼多多恢复后为已授权、只剩【停用返利】；淘宝恢复后为已失效（待用户重新授权）、有【重置授权】【停用返利】',
  async () => {
    const server = createServer(
      userDetail([binding('taobao', 'blocked'), binding('pdd', 'blocked')]),
      { writes: ['pdd/enable', 'taobao/enable'] },
    );
    await openUser(server);
    const pdd = await perform(server, 'pdd', 'enable', REASON);
    expectWrite(server, pdd.write, bindingPath('pdd', 'enable'), {
      reason: REASON,
      expected_row_version: ROW_VERSION.pdd,
    });
    await announce(pdd.prior, HINT.enable);
    await rowShows('pdd', STATUS_SHOWN.active);
    await waitFor(() => expect(entriesOf('pdd')).toEqual(['disable']));
    await closeConfirmations();

    const taobao = await perform(server, 'taobao', 'enable', REASON);
    expectWrite(server, taobao.write, bindingPath('taobao', 'enable'), {
      reason: REASON,
      expected_row_version: ROW_VERSION.taobao,
    });
    await announce(taobao.prior, HINT.enable);
    await rowShows('taobao', STATUS_SHOWN.invalid);
    await waitFor(() => expect(entriesOf('taobao')).toEqual(['reset', 'disable']));
    expect(server.writes()).toHaveLength(2);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jc-WRITE#4] 连续两次操作（先停用再恢复同一行）各弹一次动态码、令牌不同；第二次带上一次之后的新 row_version',
  async () => {
    const server = createServer(activeUser(), { writes: ['taobao/disable', 'taobao/enable'] });
    await openUser(server);
    const first = await perform(server, 'taobao', 'disable', REASON);
    await rowShows('taobao', STATUS_SHOWN.blocked);
    await closeConfirmations();
    // perform() waits for a second step-up dialog and checks that nothing left before it.
    const second = await perform(server, 'taobao', 'enable', REASON);
    expect(server.verifies()).toHaveLength(2);
    expect(passOf(first.write)).toBe(server.issued[0]);
    expect(passOf(second.write)).toBe(server.issued[1]);
    expect(passOf(second.write)).not.toBe(passOf(first.write));
    expect(server.log.indexOf(second.write)).toBeGreaterThan(
      server.log.indexOf(server.verifies()[1]!),
    );
    expect(second.write.body).toEqual({
      reason: REASON,
      expected_row_version: ROW_VERSION.taobao + 1,
    });
    expect(server.answerOf(second.write)).toBe(0);
    await rowShows('taobao', STATUS_SHOWN.invalid);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jc-WRITE#5] 连点确认与【验证并继续】、请求在途时再点：只弹一次动态码、只验证一次、只发一次写',
  async () => {
    const server = createServer(activeUser(), { writes: ['taobao/disable'] });
    await openUser(server);
    const release = server.hold('POST', bindingPath('taobao', 'disable'));
    try {
      const layer = await open(await entry('taobao', 'disable'));
      await fill(reasonField(layer), REASON);
      const submit = submitOf(layer);
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
    await rowShows('taobao', STATUS_SHOWN.blocked);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07jc-WRITE#6] 写请求回 10003：重新弹动态码，验证后用新令牌、原请求体再发一次，之后成功',
  async () => {
    const server = createServer(activeUser(), { writes: ['taobao/reset'] });
    server.once('POST', bindingPath('taobao', 'reset'), () => failure(10003, { tier: 'totp' }));
    await openUser(server);
    const { prior } = await perform(server, 'taobao', 'reset', REASON);
    await stepUp();
    await settled(server);
    expect(server.writes()).toHaveLength(1);
    expect(server.verifies()).toHaveLength(1);
    await verify(server);
    await waitFor(() => expect(server.writes()).toHaveLength(2));
    await settled(server);
    expect(server.writes().map((one) => passOf(one))).toEqual([server.issued[0], server.issued[1]]);
    const body = { reason: REASON, expected_row_version: ROW_VERSION.taobao };
    expect(server.writes().map((one) => one.body)).toEqual([body, body]);
    expect(server.writes().map((one) => one.headers.has('Idempotency-Key'))).toEqual([
      false,
      false,
    ]);
    await announce(prior, HINT.reset);
    await rowShows('taobao', STATUS_SHOWN.released);
  },
  FLOW_TIMEOUT,
);
