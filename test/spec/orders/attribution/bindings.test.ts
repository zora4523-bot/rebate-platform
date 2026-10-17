import { expect, it } from 'vitest';
import {
  resolveBinding,
  type BindingRow,
} from '../../../../apps/api/src/modules/orders/domain/attribution.ts';
import { at, ATTR } from './kit.ts';

const row = (patch: Partial<BindingRow> = {}): BindingRow => ({
  user_id: 'user-a',
  bound_at: at('2026-10-10T01:02:03.000Z'),
  released_at: null,
  cooldown_until: null,
  ...patch,
});
it('[AC-B1-08h#06] bound_at 等于 attr_at 命中，未绑定及未来绑定不命中', () => {
  expect(resolveBinding([row({ bound_at: at(ATTR) })], at(ATTR))).toEqual({
    kind: 'matched',
    user_id: 'user-a',
  });
  expect(
    resolveBinding(
      [row({ bound_at: null }), row({ bound_at: at('2026-10-15T16:00:00.001Z') })],
      at(ATTR),
    ),
  ).toEqual({ kind: 'miss', user_id: null });
});
it.each(['released_at', 'cooldown_until'] as const)(
  '[AC-B1-08h#07] attr_at 等于 %s 时不命中，截止前一毫秒仍命中',
  (field) => {
    expect(resolveBinding([row({ [field]: at(ATTR) })], at(ATTR))).toEqual({
      kind: 'miss',
      user_id: null,
    });
    expect(resolveBinding([row({ [field]: at('2026-10-15T16:00:00.001Z') })], at(ATTR))).toEqual({
      kind: 'matched',
      user_id: 'user-a',
    });
  },
);
it('[AC-B1-08h#08] cooldown_until 优先于 released_at，已释放仍可命中历史区间', () => {
  expect(
    resolveBinding(
      [
        row({
          released_at: at('2026-10-12T02:03:04.000Z'),
          cooldown_until: at('2026-10-18T03:04:05.000Z'),
        }),
      ],
      at(ATTR),
    ),
  ).toEqual({ kind: 'matched', user_id: 'user-a' });
  expect(
    resolveBinding(
      [
        row({
          released_at: at('2026-10-18T04:05:06.000Z'),
          cooldown_until: at('2026-10-14T05:06:07.000Z'),
        }),
      ],
      at(ATTR),
    ),
  ).toEqual({ kind: 'miss', user_id: null });
});
it('[AC-B1-08h#09] 多区间同一用户可归属，只有有效区间的不同用户才构成冲突', () => {
  const same = row({ bound_at: at('2026-10-11T02:03:04.000Z') });
  expect(resolveBinding([row(), same], at(ATTR))).toEqual({ kind: 'matched', user_id: 'user-a' });
  const other = row({ user_id: 'user-b', bound_at: at('2026-10-12T03:04:05.000Z') });
  expect(resolveBinding([row(), other], at(ATTR))).toEqual({ kind: 'conflict', user_id: null });
  expect(resolveBinding([other, row()], at(ATTR))).toEqual({ kind: 'conflict', user_id: null });
  expect(
    resolveBinding([row(), { ...other, released_at: at('2026-10-14T04:05:06.000Z') }], at(ATTR)),
  ).toEqual({ kind: 'matched', user_id: 'user-a' });
});
