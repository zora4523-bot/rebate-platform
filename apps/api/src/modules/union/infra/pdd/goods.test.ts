import { expect, it } from 'vitest';
import { UnionError } from '../../domain/types.ts';
import {
  checkQueryIdentity,
  feedCursor,
  parseFeedCursor,
  parseSearchCursor,
  searchCursor,
} from './goods.ts';

function code(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof UnionError) return error.code;
    throw error;
  }
  throw new Error('expected a UnionError');
}

it('[AC-B1-04u-UNIT#1] 搜索游标往返保留页码与 list_id，畸形游标 invalid_dto', () => {
  expect(parseSearchCursor(searchCursor(2, 'unit-list/列表'))).toEqual({
    page: 2,
    listId: 'unit-list/列表',
  });
  expect(parseSearchCursor(searchCursor(3, null))).toEqual({ page: 3, listId: null });
  for (const bad of ['pdd-search:1:', 'pdd-search:0:', 'pdd-search:2:a+b', 'pdd-feed:20', '']) {
    expect(code(() => parseSearchCursor(bad))).toBe('invalid_dto');
  }
});

it('[AC-B1-04u-UNIT#2] 物料游标只接受正偏移', () => {
  expect(parseFeedCursor(feedCursor(40))).toBe(40);
  for (const bad of ['pdd-feed:0', 'pdd-feed:-1', 'pdd-feed:01', 'pdd-search:2:']) {
    expect(code(() => parseFeedCursor(bad))).toBe('invalid_dto');
  }
});

it('[AC-B1-04u-UNIT#3] 查询身份原样透传，非对象或缺字段 invalid_identity', () => {
  expect(checkQueryIdentity({ pid: 'unit-pid', customParameters: '{"uid":"u"}' })).toEqual({
    pid: 'unit-pid',
    custom_parameters: '{"uid":"u"}',
  });
  for (const bad of [null, 'x', { pid: 'unit-pid' }, { customParameters: '{}' }]) {
    expect(code(() => checkQueryIdentity(bad))).toBe('invalid_identity');
  }
});
