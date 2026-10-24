import { expect, it } from 'vitest';
import { permissionDiff } from './admin-account-writes.ts';

it('[AC-B1-34k] the save deletes only the removed keys and inserts only the added ones', () => {
  expect(
    permissionDiff(
      ['user.lookup', 'order.view', 'withdraw.review'],
      ['withdraw.review', 'user.lookup', 'fund.view'],
    ),
  ).toEqual({
    before: ['order.view', 'user.lookup', 'withdraw.review'],
    after: ['fund.view', 'user.lookup', 'withdraw.review'],
    added: ['fund.view'],
    removed: ['order.view'],
  });
});

it('[AC-B1-34k] an empty set removes everything; an unchanged set touches nothing', () => {
  expect(permissionDiff(['fund.view', 'export'], [])).toEqual({
    before: ['export', 'fund.view'],
    after: [],
    added: [],
    removed: ['export', 'fund.view'],
  });
  expect(permissionDiff(['export'], ['export'])).toMatchObject({ added: [], removed: [] });
});
