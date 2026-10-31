// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ADMIN,
  BATCH,
  BILL,
  batchOf,
  billOf,
  confirmPath,
  createServer,
  rejected,
  stepUpRequired,
} from './fixtures.ts';
import {
  ENTRY,
  FLOW_TIMEOUT,
  HINT,
  before,
  chooseRadio,
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

it(
  '[AC-F1-08db-CONFIRM#6] 打开详情后另一位财务驳回了京东批次：确认收 20902，提示状态已变化并重新拉详情，京东批次显示「已取消」，淘宝批次仍待确认',
  async () => {
    const server = createServer(undefined, { writes: ['confirm'] });
    await openDetail(server, BILL.issued);
    const layer = await open(await pageEntry(ENTRY.confirmNow));
    await chooseRadio(layer, /立即/);
    const jd = batchOf(server, BATCH.issuedJd);
    jd.status = 'CANCELLED';
    jd.cancelled_reason = '另一位财务核对后驳回';
    jd.row_version = 4;
    billOf(server, BILL.issued).draft_batch_count = 1;
    const prior = before();
    await submitThroughStepUp(server, layer, 'confirm');
    await tell(prior, HINT.changed);
    await readAgain(server, BILL.issued, server.writes('confirm')[0]!);
    await rowShows(BATCH.issuedJd, 'batchStatus', 'CANCELLED');
    await rowShows(BATCH.issuedTaobao, 'batchStatus', 'DRAFT');
    expect(batchOf(server, BATCH.issuedTaobao).status).toBe('DRAFT');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08db-CONFIRM#7] 确认收 20001 data.reason=bill_not_ready：给出账单尚未出账完成一类的提示，不显示成功，批次仍待确认',
  async () => {
    const server = createServer(undefined, { writes: ['confirm'] });
    await openDetail(server, BILL.issued);
    const layer = await open(await pageEntry(ENTRY.confirmNow));
    await chooseRadio(layer, /立即/);
    server.once('POST', confirmPath(BILL.issued), () => rejected(['bill_id'], 'bill_not_ready'));
    const prior = before();
    await submitThroughStepUp(server, layer, 'confirm');
    await tell(prior, HINT.notReady);
    expect(batchOf(server, BATCH.issuedTaobao).status).toBe('DRAFT');
    await rowShows(BATCH.issuedTaobao, 'batchStatus', 'DRAFT');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08db-CONFIRM#8] 确认收 10003（动态码令牌失效）：重新弹动态码，验证后用新令牌重发同样的请求体并成功',
  async () => {
    const server = createServer(undefined, { writes: ['confirm'] });
    await openDetail(server, BILL.issued);
    const layer = await open(await pageEntry(ENTRY.confirmNow));
    await chooseRadio(layer, /立即/);
    server.once('POST', confirmPath(BILL.issued), () => stepUpRequired());
    await submitThroughStepUp(server, layer, 'confirm');
    await stepUp();
    expect(server.writes('confirm'), 'no second write before the second step-up').toHaveLength(1);
    await verify(server);
    await waitFor(() => expect(server.writes('confirm')).toHaveLength(2));
    await settled(server);
    const [first, second] = server.writes('confirm') as [
      (typeof server.log)[number],
      (typeof server.log)[number],
    ];
    expect(passOf(first)).toBe(server.issued[0]);
    expect(passOf(second)).toBe(server.issued[1]);
    expect(server.issued[0]).not.toBe(server.issued[1]);
    expect(second.body).toEqual(first.body);
    await rowShows(BATCH.issuedTaobao, 'batchStatus', 'CONFIRMED');
    expect(batchOf(server, BATCH.issuedJd).confirmed_by).toBe(ADMIN.caller);
  },
  FLOW_TIMEOUT,
);
