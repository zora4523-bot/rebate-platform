// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ID,
  RECON_GRANTS,
  REF,
  VIEW_WRITE_GRANTS,
  WRITE_GRANTS,
  createServer,
} from './fixtures.ts';
import {
  CANCEL,
  FLOW_TIMEOUT,
  NOTE,
  action,
  allWriteOffEntries,
  click,
  mount,
  openDetail,
  openWriteOff,
  settle,
  settled,
  squash,
  stepUpDialogs,
  textFields,
  writeOffDialogs,
  writeOffEntries,
} from './helpers.ts';

/** Clicks every (disabled) 【核销】 of `ref`: none of them may open anything or send anything. */
async function pressDisabled(ref: string): Promise<void> {
  for (const node of allWriteOffEntries(ref)) await click(node);
  await settle();
}

it(
  '[AC-F1-08eb-ENTRY#1] 持 fund.recon + payout.execute：R2 待处理 / 处理中的差错单详情有可用的【核销】；R3、R1 的待处理差错单与 R2 已关闭 / 已调账 / 已核销的都没有可用的【核销】，点置灰的也不弹框、不发 POST',
  async () => {
    const server = createServer(undefined, { permissions: WRITE_GRANTS });
    await mount(server);
    for (const [ref, id] of [
      [REF.late, ID.late],
      [REF.busy, ID.busy],
    ] as const) {
      await openDetail(server, ref, id);
      expect(writeOffEntries(ref).length, `${ref} a usable 【核销】`).toBeGreaterThan(0);
    }
    for (const [ref, id] of [
      [REF.ledger, ID.ledger],
      [REF.union, ID.union],
      [REF.closed, ID.closed],
      [REF.adjusted, ID.adjusted],
      [REF.written, ID.written],
    ] as const) {
      await openDetail(server, ref, id);
      expect(writeOffEntries(ref), `${ref} no usable 【核销】`).toEqual([]);
      await pressDisabled(ref);
      expect(writeOffDialogs(), `${ref} no write-off dialog`).toEqual([]);
    }
    await settled(server);
    expect(server.requests('POST')).toEqual([]);
    expect(stepUpDialogs()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08eb-ENTRY#2] 不持 payout.execute（只持 fund.recon）：R2 待处理 / 处理中的差错单都没有可用的【核销】，不发 POST；同样的差错单换成持 payout.execute 的账号就有',
  async () => {
    const writer = createServer(undefined, { permissions: WRITE_GRANTS });
    await mount(writer);
    await openDetail(writer, REF.late, ID.late);
    expect(writeOffEntries(REF.late).length, 'payout.execute: a usable 【核销】').toBeGreaterThan(
      0,
    );
    cleanup();

    const server = createServer(undefined, { permissions: RECON_GRANTS });
    await mount(server);
    for (const [ref, id] of [
      [REF.late, ID.late],
      [REF.busy, ID.busy],
    ] as const) {
      await openDetail(server, ref, id);
      expect(writeOffEntries(ref), `${ref} no usable 【核销】 without payout.execute`).toEqual([]);
      await pressDisabled(ref);
      expect(writeOffDialogs()).toEqual([]);
    }
    await settled(server);
    expect(server.requests('POST')).toEqual([]);
    expect(stepUpDialogs()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08eb-ENTRY#3] 持 fund.view + payout.execute（不持 fund.recon）：R2 待处理差错单详情照样有可用的【核销】，只打开不提交时不发 POST',
  async () => {
    const server = createServer(undefined, { permissions: VIEW_WRITE_GRANTS });
    await mount(server);
    await openDetail(server, REF.quiet, ID.quiet);
    expect(writeOffEntries(REF.quiet).length, 'a usable 【核销】').toBeGreaterThan(0);
    await settled(server);
    expect(server.requests('POST')).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08eb-ENTRY#4] 【核销】确认对话框：说明会把原提现单记为接口打款成功、不会重复打款，有选填的备注；点【取消】关闭对话框，不弹动态码、不发任何 POST，入口仍可用',
  async () => {
    const server = createServer();
    await mount(server);
    const modal = await openWriteOff(server, REF.late, ID.late);
    const text = squash(modal.textContent);
    expect(text, 'the dialog names the original withdrawal').toMatch(/提现/);
    expect(text, 'the withdrawal is recorded as paid through the interface').toMatch(
      /接口打款成功|(?:记为|标记为|改为|置为|视为).{0,6}打款成功/,
    );
    expect(text, 'no second payout').toMatch(
      /不会?(?:再)?重复打款|不(?:会)?(?:再次|重新)打款|不会?重复出款|不(?:会)?(?:再)?重复付款/,
    );
    expect(textFields(modal, NOTE), 'one note field').toHaveLength(1);
    expect(stepUpDialogs(), 'no step-up before confirming').toEqual([]);
    await click(action(modal, CANCEL));
    await settle();
    await waitFor(() => expect(writeOffDialogs()).toEqual([]));
    await settled(server);
    expect(server.requests('POST')).toEqual([]);
    expect(stepUpDialogs()).toEqual([]);
    expect(writeOffEntries(REF.late).length, 'the entry is still usable').toBeGreaterThan(0);
  },
  FLOW_TIMEOUT,
);
