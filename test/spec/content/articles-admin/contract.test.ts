import { expect, it } from 'vitest';
import { contract, ROUTES } from './kit.ts';

it.each(Object.values(ROUTES))(
  '[AC-F1-02w#32] $id 去掉 planned 并保留契约操作身份',
  async (route) => {
    const doc = await contract();
    const operation = doc.paths[route.path]![route.method.toLowerCase()]!;
    expect(operation.operationId).toBe(route.id);
    expect(operation['x-implementation']).not.toBe('planned');
  },
);
