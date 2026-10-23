import { expect, it } from 'vitest';
import { PATH, contract } from './kit.ts';

it.each([
  [PATH, 'adminListOrders'],
  [`${PATH}/{order_id}`, 'adminGetOrder'],
])('[AC-B1-10i#1] %s 移除 planned，保留后台鉴权', async (path, operationId) => {
  const operation = (await contract()).paths[path]?.get;
  expect(operation).toBeDefined();
  expect(operation?.['x-implementation']).not.toBe('planned');
  expect(operation).toMatchObject({ operationId, 'x-auth': 'admin' });
});
