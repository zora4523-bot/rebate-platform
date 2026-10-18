import { describe, expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import {
  AdminUnionBindingFieldsError,
  AdminUnionBindings,
  type AdminUnionBindingCommand,
} from './admin-union-bindings.ts';
import { nextBindingRowVersion } from './binding-lock.ts';
import { restoreSteps } from './binding-risk.ts';

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

  it('[AC-F1-07c] reset of a union other than Taobao is 20001 platform, nothing opened', async () => {
    const transaction = vi.fn();
    const service = new AdminUnionBindings({
      store: { transaction },
      clock: new FixedClock('2031-05-06T07:00:00.000Z'),
      logger: { warn: vi.fn() },
    });
    const refused = await service
      .apply({ ...command, platform: 'pdd' })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AdminUnionBindingFieldsError);
    expect((refused as AdminUnionBindingFieldsError).fields).toEqual(['platform']);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('[AC-F1-07c] enable and unban: Taobao back to invalid, another union to active through invalid', () => {
    expect(restoreSteps('taobao')).toEqual(['invalid']);
    expect(restoreSteps('pdd')).toEqual(['invalid', 'active']);
  });
});
