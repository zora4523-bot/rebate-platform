import { describe, expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import {
  AdminUnionBindingFieldsError,
  AdminUnionBindings,
  type AdminUnionBindingCommand,
} from './admin-union-bindings.ts';
import { nextBindingRowVersion } from './binding-lock.ts';

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
});
