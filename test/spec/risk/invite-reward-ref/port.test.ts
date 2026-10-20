import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('[AC-B1-35b#1] risk 公共出口接受提现及双方奖励引用，奖励必须指定合法 party', () => {
  // 用类型检查器观察真实导出：旧接口先以断言失败，而不是整个 typecheck 编译失败。
  // 不靠源码字符串匹配，因此类型别名、换行及转出位置不影响结果。
  const entry = fileURLToPath(
    new URL('../../../../apps/api/src/modules/risk/index.ts', import.meta.url),
  );
  const casesPath = fileURLToPath(new URL('./ref-type-cases.ts', import.meta.url));
  const casesSource = ts.createSourceFile(
    casesPath,
    `type Cases = {
      withdrawal: { type: 'withdrawal'; id: string };
      inviter: { type: 'invite_reward'; id: string; party: 'inviter' };
      invitee: { type: 'invite_reward'; id: string; party: 'invitee' };
      missingParty: { type: 'invite_reward'; id: string };
      optionalParty: { type: 'invite_reward'; id: string; party?: 'inviter' | 'invitee' };
      invalidParty: { type: 'invite_reward'; id: string; party: 'other' };
      undefinedParty: { type: 'invite_reward'; id: string; party: undefined };
      unknownType: { type: 'unknown'; id: string; party: 'inviter' };
      invalidId: { type: 'invite_reward'; id: number; party: 'inviter' };
    };`,
    ts.ScriptTarget.ESNext,
    true,
  );
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    target: ts.ScriptTarget.ESNext,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
    path === casesPath
      ? casesSource
      : getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([entry, casesPath], options, host);
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

  // 让真实导出类型接受/拒绝候选对象；缺 party 在旧接口上表现为断言失败，
  // 不用 @ts-expect-error，避免先红阶段的全仓 typecheck 因测试本身失败。
  const casesDeclaration = casesSource.statements[0]!;
  expect(ts.isTypeAliasDeclaration(casesDeclaration)).toBe(true);
  if (!ts.isTypeAliasDeclaration(casesDeclaration)) return;
  const cases = checker.getTypeFromTypeNode(casesDeclaration.type);
  const accepted = new Set(['withdrawal', 'inviter', 'invitee']);
  expect(cases.getProperties()).toHaveLength(9);
  for (const candidate of cases.getProperties()) {
    const candidateType = checker.getTypeOfSymbolAtLocation(candidate, casesSource);
    expect(checker.isTypeAssignableTo(candidateType, refType), candidate.name).toBe(
      accepted.has(candidate.name),
    );
  }
});
