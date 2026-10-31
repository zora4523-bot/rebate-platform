// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { BATCH, BILL, OTP, batchPath, createServer } from './fixtures.ts';
import {
  ENTRY,
  FLOW_TIMEOUT,
  click,
  closeConfirmations,
  dismissStepUp,
  open,
  openDetail,
  passOf,
  rowShows,
  rowEntry,
  settled,
  stepUp,
  submitOf,
  submitThroughStepUp,
} from './helpers.ts';

it(
  '[AC-F1-08db-STEPUP#1] 连续两次写操作（先【撤销定时】再【继续执行】）各弹一次动态码，第二次写在第二次验证之后才发，两次写带不同的令牌',
  async () => {
    const server = createServer(undefined, { writes: ['cancel-schedule', 'resume'] });
    await openDetail(server, BILL.settling);
    await submitThroughStepUp(
      server,
      await open(await rowEntry(BATCH.scheduled, ENTRY.cancelSchedule)),
      'cancel-schedule',
    );
    await rowShows(BATCH.scheduled, 'batchStatus', 'DRAFT');
    await closeConfirmations();

    // submitThroughStepUp waits for a second step-up dialog and checks no resume left before it.
    await submitThroughStepUp(
      server,
      await open(await rowEntry(BATCH.partial, ENTRY.resume)),
      'resume',
    );
    expect(server.verifies().map((one) => one.body)).toEqual([
      { tier: 'totp', code: OTP },
      { tier: 'totp', code: OTP },
    ]);
    const cancel = server.writes('cancel-schedule')[0]!;
    const resume = server.writes('resume')[0]!;
    expect(resume.path).toBe(batchPath(BATCH.partial, 'resume'));
    expect(passOf(cancel)).toBe(server.issued[0]);
    expect(passOf(resume)).toBe(server.issued[1]);
    expect(passOf(resume)).not.toBe(passOf(cancel));
    expect(server.log.indexOf(resume)).toBeGreaterThan(server.log.indexOf(server.verifies()[1]!));
    await rowShows(BATCH.partial, 'batchStatus', 'EXECUTING');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08db-STEPUP#2] 取消动态码后不发写请求、批次不变；再次【继续执行】时重新弹动态码，验证后才发 POST resume',
  async () => {
    const server = createServer(undefined, { writes: ['resume'] });
    await openDetail(server, BILL.settling);
    const layer = await open(await rowEntry(BATCH.partial, ENTRY.resume));
    await click(submitOf(layer));
    await stepUp();
    await dismissStepUp();
    await settled(server);
    expect(server.writes(), 'no write after cancelling the step-up').toEqual([]);
    expect(server.verifies()).toEqual([]);
    await rowShows(BATCH.partial, 'batchStatus', 'PARTIAL');

    await closeConfirmations();
    await submitThroughStepUp(
      server,
      await open(await rowEntry(BATCH.partial, ENTRY.resume)),
      'resume',
    );
    expect(server.writes('resume')).toHaveLength(1);
    expect(passOf(server.writes('resume')[0]!)).toBe(server.issued[0]);
    await rowShows(BATCH.partial, 'batchStatus', 'EXECUTING');
  },
  FLOW_TIMEOUT,
);
