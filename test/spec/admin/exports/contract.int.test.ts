import { expect, it } from 'vitest';
import { contract, DOWNLOAD, LIST, RETRY } from './kit.ts';

it.each([
  [LIST, 'post', 'adminCreateExport'],
  [LIST, 'get', 'adminListExports'],
  [DOWNLOAD, 'get', 'adminDownloadExport'],
  [RETRY, 'post', 'adminRetryExport'],
])('[AC-B1-34f#1] %s %s 保持 admin 鉴权并去掉 planned', async (path, method, operationId) => {
  const operation = (await contract()).paths[path!]![method!]!;
  expect(operation).toMatchObject({ operationId, 'x-auth': 'admin' });
  expect(operation['x-implementation']).not.toBe('planned');
});
