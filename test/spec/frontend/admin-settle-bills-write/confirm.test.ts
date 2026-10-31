// @vitest-environment jsdom
import { act, fireEvent, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  BATCH,
  BILL,
  OTP,
  batchOf,
  confirmPath,
  createServer,
  rejected,
  type Server,
} from './fixtures.ts';
import {
  ENTRY,
  FLOW_TIMEOUT,
  HINT,
  announce,
  before,
  chooseRadio,
  confirmations,
  enterTime,
  freshIn,
  isDisabled,
  open,
  openDetail,
  pageEntry,
  passOf,
  rowShows,
  sameMoment,
  settle,
  settled,
  sortedExpected,
  squash,
  stepUpDialogs,
  submitOf,
  submitThroughStepUp,
  textOf,
  verify,
  type Before,
} from './helpers.ts';

const DATE = '2099-01-15';
const TIME = '10:00';

/** Presses submit; when the page asks for the step-up anyway, verifies it. */
async function submitAnyway(server: Server, layer: HTMLElement): Promise<void> {
  const submit = submitOf(layer);
  await act(async () => {
    fireEvent.click(submit);
  });
  await settle();
  if (stepUpDialogs().length > 0) await verify(server);
  await settled(server);
}
/** Text new since `prior` in the confirmation dialog, which is still open. */
function freshInDialog(prior: Before): string {
  const layers = confirmations();
  expect(layers, 'the confirmation dialog stays open').toHaveLength(1);
  return freshIn(prior, layers[0]!);
}
function statuses(server: Server): string[] {
  return [BATCH.issuedTaobao, BATCH.issuedJd].map((id) => batchOf(server, id).status);
}

it(
  '[AC-F1-08db-CONFIRM#1] 【确认立即执行】：确认框说明一次确认该账单全部待确认批次；提交（连点两次）后先弹动态码，验证后只发一个 POST confirm，带动态码令牌，expected_batches 恰为两个待确认批次的 id 与 row_version，不带 scheduled_at；成功提示，两批次显示「已确认」',
  async () => {
    const server = createServer(undefined, { writes: ['confirm'] });
    await openDetail(server, BILL.issued);
    const layer = await open(await pageEntry(ENTRY.confirmNow));
    expect(squash(textOf(layer)), 'the dialog says every waiting batch is confirmed').toMatch(
      HINT.scope,
    );
    await chooseRadio(layer, /立即/);
    expect(server.requests('POST'), 'nothing sent when the dialog opens').toEqual([]);
    const prior = before();
    await submitThroughStepUp(server, layer, 'confirm', true);

    expect(server.writes('confirm')).toHaveLength(1);
    const request = server.writes('confirm')[0]!;
    expect(request.path).toBe(confirmPath(BILL.issued));
    expect(sortedExpected(request.body)).toEqual([
      { batch_id: BATCH.issuedTaobao, expected_row_version: 0 },
      { batch_id: BATCH.issuedJd, expected_row_version: 3 },
    ]);
    const body = request.body as Record<string, unknown>;
    expect(['IMMEDIATE', undefined]).toContain(body['settle_mode']);
    expect(Object.hasOwn(body, 'scheduled_at'), 'no scheduled_at with IMMEDIATE').toBe(false);
    expect(server.verifies().map((one) => one.body)).toEqual([{ tier: 'totp', code: OTP }]);
    expect(passOf(request)).toBe(server.issued[0]);

    await announce(prior, HINT.success);
    await rowShows(BATCH.issuedTaobao, 'batchStatus', 'CONFIRMED');
    await rowShows(BATCH.issuedJd, 'batchStatus', 'CONFIRMED');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08db-CONFIRM#2] 账单里有上一轮之外的待确认批次（in_current_round=false）：确认的 expected_batches 恰为全部两个 DRAFT 批次（含它），不含已完成与已取消的批次',
  async () => {
    const server = createServer(undefined, { writes: ['confirm'] });
    await openDetail(server, BILL.rounds);
    const layer = await open(await pageEntry(ENTRY.confirmNow));
    await chooseRadio(layer, /立即/);
    await submitThroughStepUp(server, layer, 'confirm');
    const request = server.writes('confirm')[0]!;
    expect(request.path).toBe(confirmPath(BILL.rounds));
    expect(sortedExpected(request.body)).toEqual([
      { batch_id: BATCH.staleDraft, expected_row_version: 2 },
      { batch_id: BATCH.freshDraft, expected_row_version: 0 },
    ]);
    await rowShows(BATCH.staleDraft, 'batchStatus', 'CONFIRMED');
    await rowShows(BATCH.freshDraft, 'batchStatus', 'CONFIRMED');
    await rowShows(BATCH.rejected, 'batchStatus', 'CANCELLED');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08db-CONFIRM#3] 【定时执行】：选定执行时间后弹动态码，POST confirm 带 settle_mode=SCHEDULED 与所选时刻的 scheduled_at、全部待确认批次；成功后两批次显示「已确认」与「定时执行」',
  async () => {
    const server = createServer(undefined, { writes: ['confirm'] });
    await openDetail(server, BILL.issued);
    const layer = await open(await pageEntry(ENTRY.schedule));
    await chooseRadio(layer, /定时/);
    await enterTime(layer, DATE, TIME);
    expect(server.requests('POST'), 'nothing sent before the step-up').toEqual([]);
    const prior = before();
    await submitThroughStepUp(server, layer, 'confirm');

    const request = server.writes('confirm')[0]!;
    expect(request.path).toBe(confirmPath(BILL.issued));
    const body = request.body as Record<string, unknown>;
    expect(body['settle_mode']).toBe('SCHEDULED');
    expect(
      sameMoment(body['scheduled_at'], DATE, TIME),
      `scheduled_at ${String(body['scheduled_at'])} is ${DATE} ${TIME}`,
    ).toBe(true);
    expect(sortedExpected(request.body)).toEqual([
      { batch_id: BATCH.issuedTaobao, expected_row_version: 0 },
      { batch_id: BATCH.issuedJd, expected_row_version: 3 },
    ]);
    expect(passOf(request)).toBe(server.issued[0]);
    await announce(prior, HINT.success);
    await rowShows(BATCH.issuedTaobao, 'batchStatus', 'CONFIRMED');
    await rowShows(BATCH.issuedTaobao, 'settleMode', 'SCHEDULED');
    await rowShows(BATCH.issuedJd, 'settleMode', 'SCHEDULED');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08db-CONFIRM#4] 定时执行未选时间：提交不可用，或提交后不确认（不发请求，或请求收 20001 [scheduled_at]）并在确认框里时间旁提示；两批次仍待确认',
  async () => {
    const server = createServer(undefined, { writes: ['confirm'] });
    await openDetail(server, BILL.issued);
    const layer = await open(await pageEntry(ENTRY.schedule));
    await chooseRadio(layer, /定时/);
    const prior = before();
    if (!isDisabled(submitOf(layer))) {
      await submitAnyway(server, layer);
      await waitFor(() =>
        expect(freshInDialog(prior), 'a hint by the schedule time').toMatch(HINT.timeInvalid),
      );
    }
    for (const request of server.writes('confirm'))
      expect((request.body as Record<string, unknown>)['settle_mode']).toBe('SCHEDULED');
    expect(statuses(server)).toEqual(['DRAFT', 'DRAFT']);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08db-CONFIRM#5] 定时时刻在确认时被服务端拒绝（20001 [scheduled_at]）：确认框仍在、在时间旁提示，不显示成功；两批次仍待确认',
  async () => {
    const server = createServer(undefined, { writes: ['confirm'] });
    await openDetail(server, BILL.issued);
    const layer = await open(await pageEntry(ENTRY.schedule));
    await chooseRadio(layer, /定时/);
    await enterTime(layer, DATE, TIME);
    server.once('POST', confirmPath(BILL.issued), () => rejected(['scheduled_at']));
    const prior = before();
    await submitThroughStepUp(server, layer, 'confirm');
    await waitFor(() =>
      expect(freshInDialog(prior), 'a hint by the schedule time').toMatch(HINT.timeInvalid),
    );
    expect(statuses(server)).toEqual(['DRAFT', 'DRAFT']);
    await rowShows(BATCH.issuedTaobao, 'batchStatus', 'DRAFT');
  },
  FLOW_TIMEOUT,
);
