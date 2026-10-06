import { expect, it } from 'vitest';
import { canTransitionPid } from './pid-status.ts';

it('[AC-B1-19b-UNIT#10] 推广位状态只进不退：只有 pending→active、active→retired 合法', () => {
  const statuses = ['pending', 'active', 'retired', 'deleted', '', null] as const;
  const legal = new Set(['pending→active', 'active→retired']);
  for (const from of statuses) {
    for (const to of statuses) {
      expect(canTransitionPid(from, to)).toBe(legal.has(`${String(from)}→${String(to)}`));
    }
  }
});
