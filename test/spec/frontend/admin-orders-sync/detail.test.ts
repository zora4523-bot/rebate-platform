// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  DETAIL_NUMBER,
  DETAIL_PLATFORM,
  DETAIL_ROUTE,
  SYNCS,
  createServer,
  streamPaused,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  PAUSED,
  REUSED,
  SUBMITTED,
  THIS_ORDER_ENTRY,
  actions,
  assertPlainWrite,
  click,
  confirmControls,
  freshText,
  main,
  mountDetail,
  pressSyncThisOrder,
  settle,
  settled,
  usable,
} from './helpers.ts';

it(
  '[AC-F1-07eb-DETAIL#1] 详情【同步此单】（可直接发或经确认）POST { platform, order_nos: [该子单号] }，平台与单号取自详情，无动态码、无 Idempotency-Key，提示已提交',
  async () => {
    const server = createServer();
    await mountDetail(server, DETAIL_ROUTE, DETAIL_NUMBER);
    expect(server.syncRequests()).toEqual([]);
    const before = await pressSyncThisOrder(server);
    await waitFor(() => expect(server.posts()).toHaveLength(1));
    await settled(server);
    const sent = server.posts()[0]!;
    assertPlainWrite(sent);
    expect(sent.body).toEqual({ platform: DETAIL_PLATFORM, order_nos: [DETAIL_NUMBER] });
    await waitFor(() => expect(freshText(before)).toMatch(SUBMITTED));
    expect(freshText(before)).not.toMatch(REUSED);
    expect(server.created()).toHaveLength(1);
    expect(server.posts()).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07eb-DETAIL#2] 同一单在排队中再点【同步此单】得 reused=true，提示已有相同同步；站长授权暂停（30156）提示该平台授权暂停；都不新建',
  async () => {
    const server = createServer();
    await mountDetail(server, DETAIL_ROUTE, DETAIL_NUMBER);
    const first = await pressSyncThisOrder(server);
    await waitFor(() => expect(server.posts()).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(freshText(first)).toMatch(SUBMITTED));
    expect(server.created()).toHaveLength(1);

    const second = await pressSyncThisOrder(server);
    await waitFor(() => expect(server.posts()).toHaveLength(2));
    await settled(server);
    expect(server.posts()[1]!.body).toEqual({
      platform: DETAIL_PLATFORM,
      order_nos: [DETAIL_NUMBER],
    });
    await waitFor(() => expect(freshText(second)).toMatch(REUSED));
    expect(server.created(), 'the reused request is not a new one').toHaveLength(1);

    server.once('POST', SYNCS, () => streamPaused(DETAIL_PLATFORM));
    const third = await pressSyncThisOrder(server);
    await waitFor(() => expect(server.posts()).toHaveLength(3));
    await settled(server);
    await waitFor(() => expect(freshText(third)).toMatch(PAUSED));
    expect(freshText(third)).not.toMatch(SUBMITTED);
    expect(freshText(third)).not.toMatch(REUSED);
    expect(server.created()).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07eb-DETAIL#3] 请求在途时连点【同步此单】（或连点它打开的确认 / 提交）只发一次 POST',
  async () => {
    const server = createServer();
    await mountDetail(server, DETAIL_ROUTE, DETAIL_NUMBER);
    await waitFor(() =>
      expect(usable(main(), THIS_ORDER_ENTRY).length, 'a usable 【同步此单】').toBeGreaterThan(0),
    );
    const release = server.hold('POST', SYNCS);
    try {
      const entry = usable(main(), THIS_ORDER_ENTRY)[0]!;
      await click(entry);
      await settle();
      // Sent at once, or a confirmation / filled dialog to confirm first.
      await waitFor(() =>
        expect(
          server.posts().length + confirmControls().length,
          'a POST or a confirmation after 【同步此单】',
        ).toBeGreaterThan(0),
      );
      if (server.posts().length === 0) {
        // Nothing in flight yet: let what it opened finish its reads (a dialog reads the limits).
        await settled(server);
        const control = confirmControls()[0]!;
        await click(control);
        await settle();
        await click(control);
        await settle();
        for (const again of confirmControls()) {
          await click(again);
          await settle();
        }
      } else {
        await click(entry);
        await settle();
        for (const again of actions(main(), THIS_ORDER_ENTRY)) {
          await click(again);
          await settle();
        }
      }
      await waitFor(() => expect(server.posts()).toHaveLength(1));
      await settle();
      expect(server.posts(), 'one POST while the first is in flight').toHaveLength(1);
    } finally {
      release();
    }
    await settled(server);
    expect(server.posts()).toHaveLength(1);
    expect(server.posts()[0]!.body).toEqual({
      platform: DETAIL_PLATFORM,
      order_nos: [DETAIL_NUMBER],
    });
    expect(server.created()).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);
