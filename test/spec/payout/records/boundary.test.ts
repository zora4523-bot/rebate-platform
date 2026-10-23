import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { contract } from '../rules/http-kit.ts';

it('[AC-B2-05f#10] 已启用两条读取接口且只读入口只有一个具名函数导出', async () => {
  const path = fileURLToPath(
    new URL('../../../../apps/api/src/modules/payout/read.ts', import.meta.url),
  );
  const program = ts.createProgram([path], { noEmit: true, allowImportingTsExtensions: true });
  const source = program.getSourceFile(path);
  expect(source).toBeDefined();
  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(source!);
  expect(symbol).toBeDefined();
  const exported = checker.getExportsOfModule(symbol!);
  expect(exported.map((item) => item.name)).toEqual(['listWithdrawalsForUser']);
  const item = exported[0]!;
  const target = item.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(item) : item;
  expect((target.flags & ts.SymbolFlags.Function) !== 0).toBe(true);
  // This is one public-boundary acceptance condition: a restricted export without live routes
  // is unfinished. Keeping planned in the test stage makes this static test fail by assertion.
  const document = await contract();
  for (const [path, operation] of [
    ['/v1/withdrawals', 'listWithdrawals'],
    ['/v1/withdrawals/{withdrawal_id}', 'getWithdrawal'],
  ]) {
    const route = document.paths[path!]!['get'];
    expect(route).toMatchObject({ operationId: operation, 'x-auth': 'login' });
    expect(route).not.toHaveProperty('x-implementation');
  }
});
