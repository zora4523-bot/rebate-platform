// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { REF, VIEW_GRANTS, createServer, diffs } from './fixtures.ts';
import {
  COLUMN,
  FLOW_TIMEOUT,
  cellText,
  mount,
  openDiffs,
  rowOf,
  squash,
  textOf,
} from './helpers.ts';

// The console dictionary without any key (as in [AC-F1-10fa-DICT#1]): every name falls back to
// its code.
vi.mock('../../../../contracts/texts.admin.default.json', () => ({ default: { texts: {} } }));

/** What a missing name must not turn into: undefined or a dictionary key path. */
const NOT_A_NAME = /undefined|admin_dict|recon_diff_type|recon_diff_status|recon_diffs\./;

it(
  '[AC-F1-08e-DICT#1] 后台字典缺键时类型、来源、状态三列显示原编码（如 ledger_mismatch / R3 / open），不显示 undefined、空白或键路径',
  async () => {
    const server = createServer(undefined, { permissions: VIEW_GRANTS });
    await mount(server);
    await openDiffs(server, REF.ledger);
    for (const item of diffs()) {
      const ref = item.ref_id;
      expect(squash(cellText(ref, COLUMN.type)), `${ref} type`).toContain(item.type);
      expect(squash(cellText(ref, COLUMN.source)), `${ref} source`).toContain(item.source);
      expect(squash(cellText(ref, COLUMN.status)), `${ref} status`).toContain(item.status);
      expect(textOf(rowOf(ref)), `${ref} row`).not.toMatch(NOT_A_NAME);
    }
  },
  FLOW_TIMEOUT,
);
