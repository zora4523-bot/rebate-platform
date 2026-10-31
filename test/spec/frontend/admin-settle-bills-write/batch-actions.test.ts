// @vitest-environment jsdom
import { act, fireEvent, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  BATCH,
  BILL,
  batchOf,
  batchPath,
  createServer,
  rejected,
  type Server,
} from './fixtures.ts';
import {
  ENTRY,
  FLOW_TIMEOUT,
  HINT,
  announce,
  batchRow,
  before,
  confirmations,
  fill,
  freshIn,
  isDisabled,
  open,
  openDetail,
  pageEntry,
  passOf,
  readAgain,
  rowEntry,
  rowShows,
  settle,
  settled,
  stepUpDialogs,
  submitOf,
  submitThroughStepUp,
  tell,
  textOf,
  textbox,
  usable,
  verify,
} from './helpers.ts';

const REASON = '联盟结算数据待核对，本批不入账';

/** Keys of a request body. */
function keys(body: unknown): string[] {
  return Object.keys(body as object).sort();
}

// ---- 撤销定时 (SB3) ------------------------------------------------------------------------

it(
  '[AC-F1-08db-CANCEL#1] 定时未开始的批次【撤销定时】：确认框 → 动态码 → POST cancel-schedule，请求体只有 expected_row_version=1；成功提示，该批次变回「待确认」，账单出现【确认立即执行】',
  async () => {
    const server = createServer(undefined, { writes: ['cancel-schedule'] });
    await openDetail(server, BILL.settling);
    const layer = await open(await rowEntry(BATCH.scheduled, ENTRY.cancelSchedule));
    expect(server.requests('POST'), 'nothing sent when the dialog opens').toEqual([]);
    const prior = before();
    await submitThroughStepUp(server, layer, 'cancel-schedule', true);
    expect(server.writes('cancel-schedule')).toHaveLength(1);
    const request = server.writes('cancel-schedule')[0]!;
    expect(request.path).toBe(batchPath(BATCH.scheduled, 'cancel-schedule'));
    expect(request.body).toEqual({ expected_row_version: 1 });
    expect(passOf(request)).toBe(server.issued[0]);
    await announce(prior, HINT.success);
    await rowShows(BATCH.scheduled, 'batchStatus', 'DRAFT');
    await pageEntry(ENTRY.confirmNow);
    expect(usable(batchRow(BATCH.scheduled), ENTRY.cancelSchedule)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08db-CANCEL#2] 撤销定时前批次已到点开始执行：POST 收 20902，提示状态已变化并重新拉详情，该批次显示「执行中」且不再有【撤销定时】',
  async () => {
    const server = createServer(undefined, { writes: ['cancel-schedule'] });
    await openDetail(server, BILL.settling);
    const layer = await open(await rowEntry(BATCH.scheduled, ENTRY.cancelSchedule));
    const scheduled = batchOf(server, BATCH.scheduled);
    scheduled.status = 'EXECUTING';
    scheduled.started_at = '2026-08-31T10:00:01+08:00';
    scheduled.row_version = 2;
    const prior = before();
    await submitThroughStepUp(server, layer, 'cancel-schedule');
    await tell(prior, HINT.changed);
    await readAgain(server, BILL.settling, server.writes('cancel-schedule')[0]!);
    await rowShows(BATCH.scheduled, 'batchStatus', 'EXECUTING');
    expect(usable(batchRow(BATCH.scheduled), ENTRY.cancelSchedule)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

// ---- 驳回 (SB4) ----------------------------------------------------------------------------

/**
 * Submits the reject dialog with `value` as the reason when its submit is usable; then the page
 * must not have rejected the batch and must say the reason is needed by the field.
 */
async function blankReason(server: Server, layer: HTMLElement, value: string): Promise<void> {
  await fill(textbox(layer, /原因/), value);
  const prior = before();
  const submit = submitOf(layer);
  if (!isDisabled(submit)) {
    await act(async () => {
      fireEvent.click(submit);
    });
    await settle();
    if (stepUpDialogs().length > 0) await verify(server);
    await settled(server);
    await waitFor(() => {
      const layers = confirmations();
      expect(layers, 'the reject dialog stays open').toHaveLength(1);
      expect(freshIn(prior, layers[0]!), `a hint for the reason ${JSON.stringify(value)}`).toMatch(
        HINT.reason,
      );
    });
  }
  for (const request of server.writes('reject'))
    expect(String((request.body as { reason?: unknown }).reason ?? '').trim()).toBe('');
  expect(batchOf(server, BATCH.issuedJd).status).toBe('DRAFT');
}

it(
  '[AC-F1-08db-REJECT#1] 待确认批次【驳回】：原因空或全空白时不驳回（不发请求，或收 20001 [reason]）并在原因旁提示；填原因后动态码 → POST reject，请求体为 expected_row_version=3 与去首尾空白后的原因；成功后该批次「已取消」并显示原因，另一批次仍待确认',
  async () => {
    const server = createServer(undefined, { writes: ['reject'] });
    await openDetail(server, BILL.issued);
    const layer = await open(await rowEntry(BATCH.issuedJd, ENTRY.reject));
    expect(server.requests('POST'), 'nothing sent when the dialog opens').toEqual([]);
    await blankReason(server, layer, '');
    await blankReason(server, layer, '   ');

    await fill(textbox(layer, /原因/), `  ${REASON}  `);
    const prior = before();
    const writes = server.writes('reject').length;
    const submit = submitOf(layer);
    await act(async () => {
      fireEvent.click(submit);
      fireEvent.click(submit);
    });
    await settle();
    // A step-up is asked for here unless one was already verified for a refused blank reason.
    if (stepUpDialogs().length > 0 || server.verifies().length === 0) {
      expect(server.writes('reject'), 'no write before the step-up').toHaveLength(writes);
      await verify(server);
    }
    await waitFor(() => expect(server.writes('reject')).toHaveLength(writes + 1));
    await settled(server);
    expect(server.writes('reject'), 'one write for the double click').toHaveLength(writes + 1);
    const request = server.writes('reject').at(-1)!;
    expect(request.path).toBe(batchPath(BATCH.issuedJd, 'reject'));
    expect(keys(request.body)).toEqual(['expected_row_version', 'reason']);
    const body = request.body as { expected_row_version: unknown; reason: unknown };
    expect(body.expected_row_version).toBe(3);
    expect(String(body.reason).trim()).toBe(REASON);
    expect(server.issued, 'a verified step-up grant').toContain(passOf(request));

    await announce(prior, HINT.success);
    await rowShows(BATCH.issuedJd, 'batchStatus', 'CANCELLED');
    await waitFor(() => expect(textOf(batchRow(BATCH.issuedJd))).toContain(REASON));
    await rowShows(BATCH.issuedTaobao, 'batchStatus', 'DRAFT');
    expect(usable(batchRow(BATCH.issuedJd), ENTRY.reject)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08db-REJECT#2] 驳回前另一位财务已确认全部批次：POST reject 收 20902，提示状态已变化并重新拉详情，两批次显示「已确认」，不再有【驳回】',
  async () => {
    const server = createServer(undefined, { writes: ['reject'] });
    await openDetail(server, BILL.issued);
    const layer = await open(await rowEntry(BATCH.issuedTaobao, ENTRY.reject));
    await fill(textbox(layer, /原因/), REASON);
    for (const id of [BATCH.issuedTaobao, BATCH.issuedJd]) {
      const one = batchOf(server, id);
      one.status = 'CONFIRMED';
      one.confirmed_by = 'ad000002-0000-4000-8000-0000000000a2';
      one.confirmed_at = '2026-09-25T10:00:00+08:00';
      one.row_version += 1;
    }
    const prior = before();
    await submitThroughStepUp(server, layer, 'reject');
    expect(server.writes('reject')[0]!.body).toMatchObject({ expected_row_version: 0 });
    await tell(prior, HINT.changed);
    await readAgain(server, BILL.issued, server.writes('reject')[0]!);
    await rowShows(BATCH.issuedTaobao, 'batchStatus', 'CONFIRMED');
    await rowShows(BATCH.issuedJd, 'batchStatus', 'CONFIRMED');
    for (const id of [BATCH.issuedTaobao, BATCH.issuedJd])
      expect(usable(batchRow(id), ENTRY.reject), id.slice(0, 8)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

// ---- 继续执行 (SB8) ------------------------------------------------------------------------

it(
  '[AC-F1-08db-RESUME#1] PARTIAL 批次【继续执行】：确认框 → 动态码 → POST resume，请求体只有 expected_row_version=4；成功提示，该批次显示「执行中」，不再有【继续执行】',
  async () => {
    const server = createServer(undefined, { writes: ['resume'] });
    await openDetail(server, BILL.settling);
    const layer = await open(await rowEntry(BATCH.partial, ENTRY.resume));
    expect(server.requests('POST'), 'nothing sent when the dialog opens').toEqual([]);
    const prior = before();
    await submitThroughStepUp(server, layer, 'resume', true);
    expect(server.writes('resume')).toHaveLength(1);
    const request = server.writes('resume')[0]!;
    expect(request.path).toBe(batchPath(BATCH.partial, 'resume'));
    expect(request.body).toEqual({ expected_row_version: 4 });
    expect(passOf(request)).toBe(server.issued[0]);
    await announce(prior, HINT.success);
    await rowShows(BATCH.partial, 'batchStatus', 'EXECUTING');
    expect(usable(batchRow(BATCH.partial), ENTRY.resume)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it.each([
  ['switches_off', HINT.switches],
  ['snapshot_pending', HINT.snapshot],
])(
  '[AC-F1-08db-RESUME#2] 继续执行收 20001 data.reason=%s：给出可识别的原因提示，不显示成功，批次仍为「部分完成」',
  async (reason, pattern) => {
    const server = createServer(undefined, { writes: ['resume'] });
    await openDetail(server, BILL.settling);
    const layer = await open(await rowEntry(BATCH.partial, ENTRY.resume));
    server.once('POST', batchPath(BATCH.partial, 'resume'), () => rejected(['batch_id'], reason));
    const prior = before();
    await submitThroughStepUp(server, layer, 'resume');
    await tell(prior, pattern);
    expect(batchOf(server, BATCH.partial).status).toBe('PARTIAL');
    await rowShows(BATCH.partial, 'batchStatus', 'PARTIAL');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08db-RESUME#3] 继续执行前批次已被他人恢复：POST resume 收 20902，提示状态已变化并重新拉详情，该批次显示「执行中」',
  async () => {
    const server = createServer(undefined, { writes: ['resume'] });
    await openDetail(server, BILL.settling);
    const layer = await open(await rowEntry(BATCH.partial, ENTRY.resume));
    const partial = batchOf(server, BATCH.partial);
    partial.status = 'EXECUTING';
    partial.row_version = 5;
    const prior = before();
    await submitThroughStepUp(server, layer, 'resume');
    await tell(prior, HINT.changed);
    await readAgain(server, BILL.settling, server.writes('resume')[0]!);
    await rowShows(BATCH.partial, 'batchStatus', 'EXECUTING');
  },
  FLOW_TIMEOUT,
);
