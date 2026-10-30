// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { GUARD_REASONS, ID, REF, STATUS_NAME, createServer } from './fixtures.ts';
import {
  DONE,
  confirmAndVerify,
  freshNotices,
  freshText,
  mount,
  openWriteOff,
  settle,
  settled,
  snapshotText,
  statusCell,
  tellsReleased,
} from './helpers.ts';

/** Five full flows, one per reason. */
const GUARD_TIMEOUT = 240_000;

it(
  '[AC-F1-08eb-GUARD#1] W11 守卫拒绝（20001 data.fields=[recon_diff_id]，data.reason 五值 not_payer_side_case / writeoff_disabled / withdrawal_not_returned / transfer_attempts_mismatch / amount_mismatch）：每种都给出提示、彼此不同，都不显示成功、不重发，差错单仍待处理',
  async () => {
    const told = new Map<string, string>();
    for (const reason of GUARD_REASONS) {
      const server = createServer(undefined, { refuse: { [ID.late]: reason } });
      await mount(server);
      const modal = await openWriteOff(server, REF.late, ID.late);
      const before = snapshotText();
      await confirmAndVerify(server, modal, ID.late);
      await waitFor(() => expect(freshText(before), `a notice for ${reason}`).not.toBe(''));
      await settle();
      await settled(server);
      const fresh = freshText(before);
      expect(freshNotices(before), `${reason}: no success`).not.toMatch(DONE);
      expect(tellsReleased(freshNotices(before), 1), `${reason}: no released hold`).toBe(false);
      expect(server.writeOffs(), `${reason}: no resend`).toHaveLength(1);
      expect(server.item(ID.late).status).toBe('open');
      expect(statusCell(REF.late)).toContain(STATUS_NAME.open);
      told.set(reason, fresh);
      cleanup();
    }
    const texts = [...told.values()];
    expect(
      new Set(texts).size,
      `five different notices: ${[...told].map(([reason, text]) => `${reason}=「${text}」`).join(' ')}`,
    ).toBe(GUARD_REASONS.length);
  },
  GUARD_TIMEOUT,
);
