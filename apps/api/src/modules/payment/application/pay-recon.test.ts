// B2-15k: implementer's unit tests of how bill.recon treats the channels' two fixed «no bill»
// answers (the acceptance tests of the chain are test/spec/payment/recon*). No database: these
// paths stop before any query; a transaction only sends the next daily run.
import { describe, expect, it } from 'vitest';
import { FixedClock, createRootLogger } from '../../platform/index.ts';
import {
  PAY_REASON_BILL_FORMAT_UNVERIFIED,
  PAY_REASON_BILL_NOT_AVAILABLE,
  PAY_REASON_CHANNEL_UNCONFIGURED,
  PAY_REASON_FAKE_NOT_SUPPORTED,
  PAY_REASON_KMS_UNAVAILABLE,
} from './pay-channel.ts';
import { runBillReconJob, runPayBillRecon, type PayReconDeps } from './pay-recon.ts';

const APP = 'couli-app-test';
const BILL_DATE = '2026-10-31';
const NOW = new Date('2026-11-01T04:00:00.000Z');
const LATER = new Date('2026-12-01T04:00:00.000Z');

interface Sent {
  readonly job: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

function harness(reason: string, now: Date = NOW) {
  const logs: string[] = [];
  const sent: Sent[] = [];
  const downloads: string[] = [];
  const deps = {
    clock: new FixedClock(now),
    logger: createRootLogger(
      { entry: 'worker', appEnv: 'test', level: 'trace' },
      {
        write: (line) => {
          logs.push(line);
        },
      },
    ),
    queue: {
      send: (_queue: string, job: string, payload: Readonly<Record<string, unknown>>) => {
        sent.push({ job, payload });
        return Promise.resolve(null);
      },
    },
    channels: {
      of: (channel: string) => ({
        channel,
        downloadBill: (date: string) => {
          downloads.push(`${channel}:${date}`);
          return Promise.resolve({ kind: 'unknown', reason });
        },
      }),
    },
    // Any table access would fail: a skipped channel writes nothing, not even «reconciled».
    db: { transaction: () => ({ execute: (run: (trx: object) => unknown) => run({}) }) },
  } as unknown as PayReconDeps;
  const messages = (): readonly string[] =>
    logs.map((line) => (JSON.parse(line) as { msg: string }).msg);
  const atLevel = (level: number): readonly string[] =>
    logs
      .map((line) => JSON.parse(line) as { level: number; msg: string })
      .filter((line) => line.level === level)
      .map((line) => line.msg);
  return { deps, sent, downloads, messages, atLevel };
}

const DAILY = { app_id: APP, bill_date: BILL_DATE };

describe('bill.recon and the fixed no-bill answers', () => {
  it('[AC-B2-15k-U#50] runPayBillRecon reports the skip and does not throw', async () => {
    for (const reason of [
      PAY_REASON_CHANNEL_UNCONFIGURED,
      PAY_REASON_KMS_UNAVAILABLE,
      PAY_REASON_FAKE_NOT_SUPPORTED,
      PAY_REASON_BILL_NOT_AVAILABLE,
      PAY_REASON_BILL_FORMAT_UNVERIFIED,
    ]) {
      const h = harness(reason);
      await expect(runPayBillRecon(h.deps, { ...DAILY, pay_channel: 'wechat_pay' })).resolves.toBe(
        'skipped',
      );
    }
  });

  it.each([
    PAY_REASON_CHANNEL_UNCONFIGURED,
    PAY_REASON_KMS_UNAVAILABLE,
    PAY_REASON_FAKE_NOT_SUPPORTED,
  ])(
    '[AC-B2-15k-U#51] %s: debug as without an adapter, only the next day is sent',
    async (reason) => {
      const h = harness(reason);
      await runBillReconJob(h.deps, DAILY);
      expect(h.atLevel(20)).toEqual(['pay_bill_recon_no_adapter', 'pay_bill_recon_no_adapter']);
      expect(h.atLevel(40)).toEqual([]);
      expect(h.atLevel(50)).toEqual([]);
      expect(h.sent.map((item) => item.payload)).toEqual([
        { app_id: APP, bill_date: '2026-11-01' },
      ]);
    },
  );

  it('[AC-B2-15k-U#52] bill_format_unverified: one warn per channel of the bill day, no catch-up', async () => {
    const h = harness(PAY_REASON_BILL_FORMAT_UNVERIFIED);
    await runBillReconJob(h.deps, DAILY);
    expect(h.atLevel(40)).toEqual(['pay_bill_format_unverified', 'pay_bill_format_unverified']);
    expect(h.messages()).not.toContain('pay_bill_unavailable');
    expect(h.messages()).not.toContain('pay_bill_recon_catch_up');
    expect(h.sent.map((item) => item.payload)).toEqual([{ app_id: APP, bill_date: '2026-11-01' }]);
    // The day is not downloaded a second time for the midnight grace: one bill per channel.
    expect(h.downloads).toHaveLength(2);
  });

  it.each([
    PAY_REASON_CHANNEL_UNCONFIGURED,
    PAY_REASON_KMS_UNAVAILABLE,
    PAY_REASON_BILL_NOT_AVAILABLE,
    PAY_REASON_BILL_FORMAT_UNVERIFIED,
  ])(
    '[AC-B2-15k-U#53] %s long past the catch-up limit: never abandoned, nothing at error level',
    async (reason) => {
      const h = harness(reason, LATER);
      await runBillReconJob(h.deps, DAILY);
      expect(h.atLevel(50)).toEqual([]);
      expect(h.messages()).not.toContain('pay_bill_recon_abandoned');
    },
  );

  it('[AC-B2-15k-U#56] bill_not_available: debug, no warn, no catch-up, not an empty bill (nothing reconciled)', async () => {
    const h = harness(PAY_REASON_BILL_NOT_AVAILABLE);
    await runBillReconJob(h.deps, DAILY);
    expect(h.atLevel(20)).toEqual(['pay_bill_not_available', 'pay_bill_not_available']);
    expect(h.atLevel(40)).toEqual([]);
    expect(h.messages()).not.toContain('pay_bill_reconciled');
    expect(h.sent.map((item) => item.payload)).toEqual([{ app_id: APP, bill_date: '2026-11-01' }]);
  });

  it('[AC-B2-15k-U#54] a catch-up run that meets them sends nothing further', async () => {
    const h = harness(PAY_REASON_BILL_FORMAT_UNVERIFIED);
    await runBillReconJob(h.deps, { ...DAILY, pay_channel: 'alipay' });
    expect(h.sent).toEqual([]);
    expect(h.atLevel(40)).toEqual(['pay_bill_format_unverified']);
  });

  it('[AC-B2-15k-U#55] any other unknown stays a bill not available yet: catch-up, then abandoned', async () => {
    const h = harness('bill_download_failed');
    await runBillReconJob(h.deps, DAILY);
    expect(h.messages()).toContain('pay_bill_unavailable');
    expect(h.messages()).toContain('pay_bill_recon_catch_up');
    expect(h.sent.filter((item) => item.payload['pay_channel'] !== undefined)).toHaveLength(2);

    const late = harness('bill_download_failed', LATER);
    await runBillReconJob(late.deps, DAILY);
    expect(late.atLevel(50)).toEqual(['pay_bill_recon_abandoned', 'pay_bill_recon_abandoned']);
  });
});
