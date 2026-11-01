import { expect, it, vi } from 'vitest';
import { usersTexts } from '../../texts/users.ts';
import type { UserDetail } from './model.ts';
import { refreshDetail } from './UnionBindingActions.tsx';

const detail = { user_id: 'u1', union_bindings: [] } as unknown as UserDetail;

it('[AC-F1-07jc-ERROR#1] 刷新成功：把新详情交给 apply，不调 onFail', async () => {
  const apply = vi.fn();
  const onFail = vi.fn();
  await refreshDetail(() => Promise.resolve(detail), apply, onFail);
  expect(apply).toHaveBeenCalledWith(detail);
  expect(onFail).not.toHaveBeenCalled();
});

it('[AC-F1-07jc-ERROR#1] 刷新失败（网络或 5xx）：调用 onFail，不吞掉、不抛出、不改详情', async () => {
  const apply = vi.fn();
  const onFail = vi.fn();
  await expect(
    refreshDetail(() => Promise.reject(new Error('503')), apply, onFail),
  ).resolves.toBeUndefined();
  expect(onFail).toHaveBeenCalledTimes(1);
  expect(apply).not.toHaveBeenCalled();
});

it('[AC-F1-07jc-ERROR#2] 20902 / 30154 的提示不声称「已刷新」，刷新失败另有提示', () => {
  const t = usersTexts.unionBindings;
  expect(t.changed).not.toContain('已刷新');
  expect(t.notAllowed).not.toContain('已刷新');
  expect(t.refreshFailed).toContain('刷新页面');
});
