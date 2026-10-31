// B1-03zd: the three read operations of CT-24r are implemented — no longer planned in the contract
// or in the generated planned list — and keep admin auth. The write operations (B1-03ze) are not
// asserted either way.
import { expect, it } from 'vitest';
import { plannedOperations } from '../../../../packages/contracts-ts/src/planned-operations.gen.ts';
import { BLOCKED, LIST, ONE, contract } from './kit.ts';

const READS = [
  [LIST, 'adminListAppeals'],
  [ONE, 'adminGetAppeal'],
  [BLOCKED, 'adminListBlockedRequests'],
] as const;

it.each(READS)(
  '[AC-B1-03zd#1] GET %s（%s）去掉 planned，仍是后台鉴权',
  async (path, operationId) => {
    const operation = (await contract()).paths[path]?.get;
    expect(operation).toBeDefined();
    expect(operation).toMatchObject({ operationId, 'x-auth': 'admin' });
    expect(operation?.['x-implementation']).not.toBe('planned');
  },
);

it('[AC-B1-03zd#2] 生成的 planned 清单不再含三个只读接口', () => {
  for (const [, operationId] of READS) {
    expect(plannedOperations.has(operationId), operationId).toBe(false);
  }
});
