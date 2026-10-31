// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  PLATFORM_NAME,
  SYNCS,
  createServer,
  denied,
  networkDown,
  rateLimited,
} from './fixtures.ts';
import {
  FAILED,
  FLOW_TIMEOUT,
  FORBIDDEN,
  PAUSED,
  RATE_LIMITED,
  REUSED,
  SUBMIT,
  SUBMITTED,
  action,
  assertPlainWrite,
  click,
  freshText,
  mountList,
  prepareOrderNos,
  settle,
  settled,
  snapshotText,
  submit,
  wait,
} from './helpers.ts';

const SAMPLE_NO = '231012-4440000009';
/** A short Retry-After of the 429 sample, so the case can wait past it. */
const RETRY_AFTER_SECONDS = 1;

it(
  '[AC-F1-07eb-RESULT#1] 200 reused=false 提示已提交 / 排队；同一筛选再提交得 reused=true，提示已有相同同步在进行，与新建提示可区分、不当作新建',
  async () => {
    const { server } = await mountList();
    const first = await prepareOrderNos(server, PLATFORM_NAME.pdd, [SAMPLE_NO]);
    const before = snapshotText();
    await submit(first);
    await waitFor(() => expect(server.posts()).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(freshText(before)).toMatch(SUBMITTED));
    const created = freshText(before);
    expect(created).not.toMatch(REUSED);
    expect(server.created()).toHaveLength(1);

    const second = await prepareOrderNos(server, PLATFORM_NAME.pdd, [SAMPLE_NO]);
    const again = snapshotText();
    await submit(second);
    await waitFor(() => expect(server.posts()).toHaveLength(2));
    await settled(server);
    expect(server.posts()[1]!.body).toEqual(server.posts()[0]!.body);
    await waitFor(() => expect(freshText(again)).toMatch(REUSED));
    expect(freshText(again)).not.toBe(created);
    expect(server.created(), 'the reused request is not a new one').toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07eb-RESULT#2] 30156（站长授权暂停）提示该平台授权暂停，与成功、复用提示都不同，不建同步',
  async () => {
    const server = createServer({ paused: ['taobao'] });
    await mountList(server);
    const dialog = await prepareOrderNos(server, PLATFORM_NAME.taobao, [SAMPLE_NO]);
    const before = snapshotText();
    await submit(dialog);
    await waitFor(() => expect(server.posts()).toHaveLength(1));
    await settled(server);
    assertPlainWrite(server.posts()[0]!);
    await waitFor(() => expect(freshText(before)).toMatch(PAUSED));
    expect(freshText(before)).not.toMatch(SUBMITTED);
    expect(freshText(before)).not.toMatch(REUSED);
    expect(server.created()).toEqual([]);
    expect(server.posts()).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07eb-RESULT#3] 10403 提示无权限，不显示成功',
  async () => {
    const { server } = await mountList();
    server.once('POST', SYNCS, () => denied());
    const dialog = await prepareOrderNos(server, PLATFORM_NAME.pdd, [SAMPLE_NO]);
    const before = snapshotText();
    await submit(dialog);
    await waitFor(() => expect(server.posts()).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(freshText(before)).toMatch(FORBIDDEN));
    expect(freshText(before)).not.toMatch(SUBMITTED);
    expect(freshText(before)).not.toMatch(REUSED);
    expect(server.posts()).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07eb-RESULT#4] 429 提示稍后再试，不显示成功；过了 Retry-After 再多等一段也不自动重发，手动再提交才发且只发一次',
  async () => {
    const { server } = await mountList();
    server.once('POST', SYNCS, () => rateLimited(RETRY_AFTER_SECONDS));
    const dialog = await prepareOrderNos(server, PLATFORM_NAME.pdd, [SAMPLE_NO]);
    const before = snapshotText();
    await submit(dialog);
    await waitFor(() => expect(server.posts()).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(freshText(before)).toMatch(RATE_LIMITED));
    expect(freshText(before)).not.toMatch(SUBMITTED);
    // Past the Retry-After the fixture gave, and then some more.
    await wait(RETRY_AFTER_SECONDS * 1_000 + 2_000);
    await settled(server);
    expect(server.posts(), 'no automatic resend after Retry-After').toHaveLength(1);
    expect(server.created()).toEqual([]);

    // Only a press of the operator sends again (in the dialog still open, or opened again).
    const retry = await prepareOrderNos(server, PLATFORM_NAME.pdd, [SAMPLE_NO]);
    expect(server.posts(), 'nothing is sent before the press').toHaveLength(1);
    const again = snapshotText();
    await submit(retry);
    await waitFor(() => expect(server.posts()).toHaveLength(2));
    await settled(server);
    expect(server.posts()[1]!.body).toEqual({ platform: 'pdd', order_nos: [SAMPLE_NO] });
    await waitFor(() => expect(freshText(again)).toMatch(SUBMITTED));
    expect(server.posts()).toHaveLength(2);
    expect(server.created()).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07eb-RESULT#5] 网络失败提示失败，不显示成功或复用',
  async () => {
    const { server } = await mountList();
    server.once('POST', SYNCS, () => networkDown());
    const dialog = await prepareOrderNos(server, PLATFORM_NAME.pdd, [SAMPLE_NO]);
    const before = snapshotText();
    await submit(dialog);
    await waitFor(() => expect(server.posts()).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(freshText(before)).toMatch(FAILED));
    expect(freshText(before)).not.toMatch(SUBMITTED);
    expect(freshText(before)).not.toMatch(REUSED);
    expect(server.created()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07eb-RESULT#6] 请求在途时连点【提交同步】只发一次 POST',
  async () => {
    const { server } = await mountList();
    const dialog = await prepareOrderNos(server, PLATFORM_NAME.pdd, [SAMPLE_NO]);
    const release = server.hold('POST', SYNCS);
    const button = action(dialog, SUBMIT);
    try {
      await click(button);
      await settle();
      await click(button);
      await settle();
      await click(button);
      await settle();
      expect(server.posts()).toHaveLength(1);
    } finally {
      release();
    }
    await settled(server);
    expect(server.posts()).toHaveLength(1);
    expect(server.created()).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);
