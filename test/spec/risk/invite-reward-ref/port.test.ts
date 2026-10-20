import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('[AC-B1-35b#1] risk 公共出口的同设备输入只接受 withdrawal 与 invite_reward', () => {
  // 用类型检查器观察真实导出：旧接口先以断言失败，而不是整个 typecheck 编译失败。
  // 不靠源码字符串匹配，因此类型别名、换行及转出位置不影响结果。
  const entry = fileURLToPath(
    new URL('../../../../apps/api/src/modules/risk/index.ts', import.meta.url),
  );
  const program = ts.createProgram([entry], {
    module: ts.ModuleKind.NodeNext,
    target: ts.ScriptTarget.ESNext,
    noEmit: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  expect(source).toBeDefined();
  const module = checker.getSymbolAtLocation(source!);
  expect(module).toBeDefined();
  const exported = checker
    .getExportsOfModule(module!)
    .find((symbol) => symbol.name === 'SameDeviceAccountsInput');
  expect(exported).toBeDefined();
  const symbol =
    exported!.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported!) : exported!;
  const input = checker.getDeclaredTypeOfSymbol(symbol);
  const ref = input.getProperty('ref');
  expect(ref).toBeDefined();
  const refType = checker.getTypeOfSymbolAtLocation(ref!, source!);
  const type = refType.getProperty('type');
  expect(type).toBeDefined();
  const allowed = checker.getTypeOfSymbolAtLocation(type!, source!);
  const members = allowed.isUnion() ? allowed.types : [allowed];
  expect(
    members.map((member) => (member.isStringLiteral() ? member.value : '<non-literal>')).sort(),
  ).toEqual(['invite_reward', 'withdrawal']);
});
