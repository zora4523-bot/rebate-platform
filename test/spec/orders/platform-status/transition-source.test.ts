import * as domain from '@couli/domain';
import { expect, it, vi } from 'vitest';
import { planOrderUpdate } from '../../../../apps/api/src/modules/orders/index.ts';
import { at, order, SETTLED, statusMap } from '../attribution/kit.ts';

vi.mock('@couli/domain', { spy: true });

it('[AC-B1-08i#45] P5 判定及每条补写 history 都调用生成的 transitionOrderPlatform', () => {
  const transition = vi.mocked(domain.transitionOrderPlatform);
  transition.mockClear();
  try {
    const plan = planOrderUpdate(
      { platform_status: 'DEPOSIT_PAID', rebate_status: 'ESTIMATED', received_at: null },
      order({ raw_status: 'settled', settled_at: at(SETTLED) }),
      statusMap('pdd'),
      true,
    );
    expect(plan.history).toHaveLength(3);
    for (const [from, event] of [
      ['DEPOSIT_PAID', 'PLATFORM_SETTLED'],
      ['DEPOSIT_PAID', 'PLATFORM_PAID'],
      ['PAID', 'PLATFORM_RECEIVED'],
      ['RECEIVED', 'PLATFORM_SETTLED'],
    ]) {
      expect(transition).toHaveBeenCalledWith(from, event);
    }
  } finally {
    transition.mockClear();
  }
});
