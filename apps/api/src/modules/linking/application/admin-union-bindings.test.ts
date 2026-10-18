import { describe, expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import {
  AdminUnionBindingFieldsError,
  AdminUnionBindings,
  type AdminUnionBindingCommand,
} from './admin-union-bindings.ts';
import { nextBindingRowVersion } from './binding-lock.ts';
import { reauthorizationSince } from './pdd-authority.ts';

const command: AdminUnionBindingCommand = {
  action: 'reset',
  appId: 'synthetic-app',
  adminId: '0199a3b4-5c6d-7000-8000-0000000000a1',
  ip: null,
  userId: '0199a3b4-5c6d-7000-8000-000000000001',
  platform: 'jd',
  reason: 'synthetic',
  expectedRowVersion: 0,
};

describe('admin union bindings (F1-07c)', () => {
  it('[AC-F1-07c] a platform without user authorization is 20001 platform, nothing opened', async () => {
    const transaction = vi.fn();
    const service = new AdminUnionBindings({
      store: { transaction },
      clock: new FixedClock('2031-05-06T07:00:00.000Z'),
      logger: { warn: vi.fn() },
    });
    for (const action of ['reset', 'disable', 'enable'] as const) {
      const refused = await service.apply({ ...command, action }).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(AdminUnionBindingFieldsError);
      expect((refused as AdminUnionBindingFieldsError).fields).toEqual(['platform']);
    }
    expect(transaction).not.toHaveBeenCalled();
  });

  it('[AC-F1-07c] a new binding row continues after the highest earlier row_version', () => {
    expect(nextBindingRowVersion([])).toBe(0);
    expect(nextBindingRowVersion([{ row_version: 8 }, { row_version: 101 }])).toBe(102);
    expect(nextBindingRowVersion([{ row_version: 0 }])).toBe(1);
  });

  it('[AC-F1-07c] a restored cooling row takes the highest row_version + 1, so a stale CAS misses it', () => {
    // R 0 → reset 1; S new 2 → reset 3 (a console page still holds S at 2 or 3); R restored.
    const rows = [
      { id: 'R', row_version: 1 },
      { id: 'S', row_version: 3 },
    ];
    const restored = nextBindingRowVersion(rows);
    expect(restored).toBe(4);
    // R's own + 1 (2) would be S's old value: the stale disable would act on R instead of 20902.
    for (const stale of [0, 1, 2, 3]) expect(stale).not.toBe(restored);
  });

  it('[AC-F1-07c] pdd refresh and open: only rows the console left for re-authorization are held back', () => {
    const at = (iso: string) => new Date(iso);
    const t1 = at('2031-01-01T00:00:00Z');
    const t2 = at('2031-02-01T00:00:00Z');
    const row = (status: string, reason: string | null, released: Date | null, updated: Date) => ({
      status,
      reason,
      released_at: released,
      updated_at: updated,
    });
    expect(reauthorizationSince([])).toBeNull();
    // enable → invalid with the console's reason; inspection's invalid carries none.
    expect(reauthorizationSince([row('invalid', 'synthetic', null, t2)])).toEqual(t2);
    expect(reauthorizationSince([row('invalid', null, null, t2)])).toBeNull();
    expect(reauthorizationSince([row('pending_auth', null, null, t2)])).toBeNull();
    // reset → released with a reason, no current row: no automatic new row.
    expect(
      reauthorizationSince([row('released', null, t1, t1), row('released', 'synthetic', t2, t2)]),
    ).toEqual(t2);
    expect(
      reauthorizationSince([row('released', 'synthetic', t1, t1), row('released', null, t2, t2)]),
    ).toBeNull();
    // A current row decides over the released history.
    expect(
      reauthorizationSince([row('released', 'synthetic', t1, t1), row('invalid', null, null, t2)]),
    ).toBeNull();
  });
});
