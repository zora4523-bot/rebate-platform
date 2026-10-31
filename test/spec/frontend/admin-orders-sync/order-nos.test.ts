// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { PLATFORM_NAME, SYNCS, createServer, limits, rejected } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  ORDER_NOS,
  REUSED,
  SUBMIT,
  SUBMITTED,
  action,
  assertPlainWrite,
  assertWindowBody,
  chooseMode,
  choosePlatform,
  click,
  fieldError,
  fill,
  fillWindow,
  freshText,
  isDisabled,
  mountList,
  openSyncDialog,
  prepareOrderNos,
  settle,
  settled,
  snapshotText,
  submit,
  syncDialog,
  textbox,
} from './helpers.ts';

const FIRST_NO = '231008-7770000101';
const SECOND_NO = '231008-7770000102';
const THIRD_NO = '231008-7770000103';
const FOURTH_NO = '231008-7770000104';

it(
  '[AC-F1-07eb-NOS#1] 按订单号补拉：每行一个单号（去掉首尾空白与空行），body 恰为 platform + order_nos、不带 from / to，无动态码、无 Idempotency-Key，提示已提交',
  async () => {
    const { server } = await mountList();
    const dialog = await openSyncDialog();
    await settled(server);
    await chooseMode(dialog, 'order_nos');
    await choosePlatform(dialog, PLATFORM_NAME.taobao);
    await fill(textbox(dialog, ORDER_NOS), `  ${FIRST_NO}\n${SECOND_NO}  \n\n`);
    await settle();
    expect(server.posts()).toEqual([]);
    const before = snapshotText();
    await submit(dialog);
    await waitFor(() => expect(server.posts()).toHaveLength(1));
    await settled(server);
    const sent = server.posts()[0]!;
    assertPlainWrite(sent);
    expect(sent.body).toEqual({ platform: 'taobao', order_nos: [FIRST_NO, SECOND_NO] });
    await waitFor(() => expect(freshText(before)).toMatch(SUBMITTED));
    expect(freshText(before)).not.toMatch(REUSED);
    expect(server.created()).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07eb-NOS#2] 单号个数超出 limits 的 max_order_nos：前端拦下或收 20001 [order_nos]，都在单号旁提示、不建同步；改到上限内再提交才建同步',
  async () => {
    const server = createServer({
      limits: limits().map((one) => (one.platform === 'pdd' ? { ...one, max_order_nos: 3 } : one)),
    });
    await mountList(server);
    const dialog = await prepareOrderNos(server, PLATFORM_NAME.pdd, [
      FIRST_NO,
      SECOND_NO,
      THIRD_NO,
      FOURTH_NO,
    ]);
    const before = snapshotText();
    await submit(dialog);
    await settled(server);
    await waitFor(() =>
      expect(
        fieldError(textbox(syncDialog(), ORDER_NOS)),
        'a hint next to the order numbers',
      ).not.toBe(''),
    );
    await settled(server);
    expect(server.created()).toEqual([]);
    expect(freshText(before)).not.toMatch(SUBMITTED);

    await fill(textbox(syncDialog(), ORDER_NOS), [FIRST_NO, SECOND_NO, THIRD_NO].join('\n'));
    await settle();
    const sent = server.posts().length;
    const again = snapshotText();
    await submit(syncDialog());
    await waitFor(() => expect(server.posts()).toHaveLength(sent + 1));
    await settled(server);
    expect(server.posts().at(-1)!.body).toEqual({
      platform: 'pdd',
      order_nos: [FIRST_NO, SECOND_NO, THIRD_NO],
    });
    expect(server.created()).toHaveLength(1);
    await waitFor(() => expect(freshText(again)).toMatch(SUBMITTED));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07eb-NOS#3] 两种形态不混用：填过时间窗再切到按订单号只发 platform + order_nos；填过单号再切回按时间窗只发 platform + from / to',
  async () => {
    const { server } = await mountList();
    const dialog = await openSyncDialog();
    await settled(server);
    await chooseMode(dialog, 'window');
    await choosePlatform(dialog, PLATFORM_NAME.pdd);
    await fillWindow(dialog, '2026-10-21 00:00', '2026-10-22 00:00');
    await chooseMode(syncDialog(), 'order_nos');
    await fill(textbox(syncDialog(), ORDER_NOS), FIRST_NO);
    await settle();
    await submit(syncDialog());
    await waitFor(() => expect(server.posts()).toHaveLength(1));
    await settled(server);
    expect(server.posts()[0]!.body).toEqual({ platform: 'pdd', order_nos: [FIRST_NO] });

    const reopened = await openSyncDialog();
    await settled(server);
    await chooseMode(reopened, 'order_nos');
    await choosePlatform(reopened, PLATFORM_NAME.pdd);
    await fill(textbox(reopened, ORDER_NOS), SECOND_NO);
    await settle();
    await chooseMode(syncDialog(), 'window');
    await fillWindow(syncDialog(), '2026-10-23 00:00', '2026-10-24 00:00');
    await submit(syncDialog());
    await waitFor(() => expect(server.posts()).toHaveLength(2));
    await settled(server);
    assertWindowBody(
      server.posts()[1]!,
      'pdd',
      '2026-10-23T00:00:00+08:00',
      '2026-10-24T00:00:00+08:00',
    );
    expect(server.created()).toHaveLength(2);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07eb-NOS#4] 服务端回 20001 data.fields=[order_nos]：单号旁提示，对话框不关、不显示成功、不自动重发',
  async () => {
    const { server } = await mountList();
    server.once('POST', SYNCS, () => rejected(['order_nos']));
    const dialog = await prepareOrderNos(server, PLATFORM_NAME.pdd, [FIRST_NO]);
    const before = snapshotText();
    await submit(dialog);
    await waitFor(() => expect(server.posts()).toHaveLength(1));
    await settled(server);
    expect(server.posts()[0]!.body).toEqual({ platform: 'pdd', order_nos: [FIRST_NO] });
    await waitFor(() =>
      expect(
        fieldError(textbox(syncDialog(), ORDER_NOS)),
        'a hint next to the order numbers',
      ).not.toBe(''),
    );
    expect(server.posts()).toHaveLength(1);
    expect(server.created()).toEqual([]);
    expect(freshText(before)).not.toMatch(SUBMITTED);
  },
  FLOW_TIMEOUT,
);

/**
 * Submits the order number form holding `typed` (nothing typed when undefined) and checks the
 * refusal, one of: the submit is greyed out and pressing it sends nothing; pressing it shows a
 * hint next to the order numbers without sending; or it is sent and answered 20001 [order_nos]
 * with that hint. Either way no sync created, no success shown.
 */
async function refusesNoNumbers(typed: string | undefined): Promise<void> {
  const { server } = await mountList();
  const dialog = await openSyncDialog();
  await settled(server);
  await chooseMode(dialog, 'order_nos');
  await choosePlatform(dialog, PLATFORM_NAME.pdd);
  if (typed !== undefined) await fill(textbox(syncDialog(), ORDER_NOS), typed);
  await settle();
  const before = snapshotText();
  const press = action(syncDialog(), SUBMIT);
  const greyed = isDisabled(press);
  await click(press);
  await settle();
  await settled(server);
  if (greyed) {
    expect(server.posts(), 'a greyed out submit sends nothing').toEqual([]);
  } else {
    await waitFor(() =>
      expect(
        fieldError(textbox(syncDialog(), ORDER_NOS)),
        'a hint next to the order numbers',
      ).not.toBe(''),
    );
  }
  await settled(server);
  expect(server.created()).toEqual([]);
  expect(freshText(before)).not.toMatch(SUBMITTED);
  expect(freshText(before)).not.toMatch(REUSED);
  for (const sent of server.posts()) {
    expect(sent.body, 'the order number form only').not.toHaveProperty('from');
    expect(sent.body, 'the order number form only').not.toHaveProperty('to');
  }
}

it(
  '[AC-F1-07eb-NOS#5] 没填单号：提交置灰不发请求，或点提交后在单号旁提示（不发或收 20001 [order_nos]）；都不建同步、不显示成功',
  async () => {
    await refusesNoNumbers(undefined);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07eb-NOS#6] 单号只有空白与空行：提交置灰不发请求，或点提交后在单号旁提示（不发或收 20001 [order_nos]）；都不建同步、不显示成功',
  async () => {
    await refusesNoNumbers('   \n\n  \n');
  },
  FLOW_TIMEOUT,
);
