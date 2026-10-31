// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  BATCH,
  BILL,
  billOf,
  createServer,
  rejected,
  stepUpRequired,
  supplementPath,
  type Server,
} from './fixtures.ts';
import {
  ENTRY,
  FLOW_TIMEOUT,
  HINT,
  batchRows,
  before,
  choosePlatform,
  closeConfirmations,
  open,
  openDetail,
  pageEntry,
  passOf,
  readAgain,
  rowShows,
  settled,
  stepUp,
  submitThroughStepUp,
  tell,
  verify,
} from './helpers.ts';

const TAOBAO = /淘宝/;

/** Opens 【发起补充批次】 of the shown bill, picks taobao and goes through the step-up. */
async function launch(server: Server): Promise<void> {
  const layer = await open(await pageEntry(ENTRY.supplement));
  await choosePlatform(layer, 'taobao', TAOBAO);
  expect(server.writes('supplement'), 'nothing sent when the dialog opens').toEqual([]);
  await submitThroughStepUp(server, layer, 'supplement');
}
function idempotencyOf(request: { headers: Headers }): string | null {
  return request.headers.get('Idempotency-Key');
}

it(
  '[AC-F1-08db-SUPPLEMENT#1] 已结算账单【发起补充批次】：确认 → 动态码 → POST supplement-batches，请求体只有 platform=taobao，带 Idempotency-Key 与动态码令牌；按返回刷新详情，新的补充批次以「待确认」出现，账单出现【确认立即执行】',
  async () => {
    const server = createServer(undefined, { writes: ['supplement'] });
    await openDetail(server, BILL.settled);
    await launch(server);
    expect(server.writes('supplement')).toHaveLength(1);
    const request = server.writes('supplement')[0]!;
    expect(request.path).toBe(supplementPath(BILL.settled));
    expect(request.body).toEqual({ platform: 'taobao' });
    expect(idempotencyOf(request), 'Idempotency-Key').toMatch(/\S/);
    expect(passOf(request)).toBe(server.issued[0]);
    await waitFor(() =>
      expect(batchRows(BATCH.created), 'the new supplement batch').toHaveLength(1),
    );
    await rowShows(BATCH.created, 'batchStatus', 'DRAFT');
    await rowShows(BATCH.created, 'batchKind', 'supplement');
    await pageEntry(ENTRY.confirmNow);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08db-SUPPLEMENT#2] 补充校验无可纳入数据（outcome=generated、batch_ids 为空）：提示无可纳入数据，不出现新批次、不显示空批次',
  async () => {
    const server = createServer(undefined, { writes: ['supplement'], supplement: 'none' });
    await openDetail(server, BILL.settled);
    const prior = before();
    await launch(server);
    await tell(prior, HINT.nothing);
    await settled(server);
    expect(batchRows(BATCH.created)).toEqual([]);
    expect(billOf(server, BILL.settled).batches).toHaveLength(2);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08db-SUPPLEMENT#3] 补充批次同一次发起收 10003 后重弹动态码，重发沿用同一个 Idempotency-Key、换新令牌；之后重新打开对话框再发起时换新的 Idempotency-Key',
  async () => {
    const server = createServer(undefined, { writes: ['supplement'], supplement: 'none' });
    await openDetail(server, BILL.settled);
    server.once('POST', supplementPath(BILL.settled), () => stepUpRequired());
    await launch(server);
    await stepUp();
    expect(server.writes('supplement')).toHaveLength(1);
    await verify(server);
    await waitFor(() => expect(server.writes('supplement')).toHaveLength(2));
    await settled(server);
    const [first, second] = server.writes('supplement');
    expect(idempotencyOf(first!), 'Idempotency-Key').toMatch(/\S/);
    expect(idempotencyOf(second!), 'the replay keeps its key').toBe(idempotencyOf(first!));
    expect(passOf(second!)).toBe(server.issued[1]);
    expect(second!.body).toEqual(first!.body);

    await closeConfirmations();
    await launch(server);
    expect(server.writes('supplement')).toHaveLength(3);
    const third = server.writes('supplement')[2]!;
    expect(idempotencyOf(third), 'Idempotency-Key').toMatch(/\S/);
    expect(idempotencyOf(third), 'a new opening uses a new key').not.toBe(idempotencyOf(first!));
    expect(passOf(third)).toBe(server.issued[2]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08db-SUPPLEMENT#4] 发起返回 outcome=duplicate（同一时刻已发起过）：不出现新批次，并重新拉详情',
  async () => {
    const server = createServer(undefined, { writes: ['supplement'], supplement: 'duplicate' });
    await openDetail(server, BILL.settled);
    await launch(server);
    await readAgain(server, BILL.settled, server.writes('supplement')[0]!);
    expect(batchRows(BATCH.created)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it.each([
  ['pending_draft', ['bill_id'], HINT.pendingDraft],
  ['credit_disabled', ['platform'], HINT.credit],
])(
  '[AC-F1-08db-SUPPLEMENT#5] 发起收 20001 data.reason=%s：给出可识别的原因提示，不出现新批次',
  async (reason, fields, pattern) => {
    const server = createServer(undefined, { writes: ['supplement'] });
    await openDetail(server, BILL.settled);
    server.once('POST', supplementPath(BILL.settled), () => rejected(fields, reason));
    const prior = before();
    await launch(server);
    await tell(prior, pattern);
    await settled(server);
    expect(batchRows(BATCH.created)).toEqual([]);
  },
  FLOW_TIMEOUT,
);
