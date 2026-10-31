// B1-03ze: the three write operations of CT-24r are implemented — no longer planned in the contract
// or in the generated planned list — and keep admin auth.
import { expect, it } from 'vitest';
import { plannedOperations } from '../../../../packages/contracts-ts/src/planned-operations.gen.ts';
import { contract } from '../admin-appeals-read/kit.ts';
import { CLAIM, LIST, RESOLVE } from './kit.ts';

const WRITES = [
  [LIST, 'adminRegisterAppeal'],
  [CLAIM, 'adminClaimAppeal'],
  [RESOLVE, 'adminResolveAppeal'],
] as const;

it.each(WRITES)(
  '[AC-B1-03ze#1] POST %s（%s）去掉 planned，仍是后台鉴权',
  async (path, operationId) => {
    const operation = (await contract()).paths[path]?.post;
    expect(operation).toBeDefined();
    expect(operation).toMatchObject({ operationId, 'x-auth': 'admin' });
    expect(operation?.['x-implementation']).not.toBe('planned');
  },
);

it('[AC-B1-03ze#2] 生成的 planned 清单不再含三个写接口', () => {
  for (const [, operationId] of WRITES) {
    expect(plannedOperations.has(operationId), operationId).toBe(false);
  }
});
