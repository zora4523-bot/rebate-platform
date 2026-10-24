// CT-06zt · BR-AI-02 ③: the two dependency relays the module dependency check (CT-06zq's
// dependency-cruiser rule) cannot see. ① A file of a whitelisted module (parsing, catalog, linking,
// orders, content, taolijin, identity, platform, union) value-imports another module and exports
// that value in its own name, so the module's index.ts (`export *` / `export { … } from './x.ts'`)
// hands it to agent. ② `import Def, { type T } from '<module>'`, taken for type-only by the
// dependency check, smuggles the value Def from a module agent may name for types only (linking,
// orders, identity, union) or not at all. 判定口径: header of scan.ts. Static scan over the
// TypeScript AST of apps/api/src/modules/** (test files and dist excluded); every rule is also run
// on in-memory samples: each violating form is reported, each allowed form is not. No database.
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  MODULES,
  RELAY_MODULES,
  TYPE_ONLY_MODULES,
  mixedImportViolations,
  moduleOf,
  moduleSources,
  relayViolations,
  type SourceFile,
} from './scan.ts';

function sample(owner: string, path: string, text: string): SourceFile {
  return { path: join(MODULES, owner, path), text };
}

const UNION = "'../../union/index.ts'";
const IMPORT_IS_PLATFORM = `import { isPlatform } from ${UNION};\n`;
const IMPORT_UNION_NS = `import * as union from ${UNION};\n`;

it('[AC-CT-06zt#1][BR-AI-02] 主干：白名单九个模块的任何文件都不以自己名义导出别模块的值（经 index 转给 agent 的中转）', () => {
  const sources = moduleSources();
  const scanned = sources.filter((s) =>
    (RELAY_MODULES as readonly string[]).includes(moduleOf(s.path) ?? ''),
  );
  // The scan reaches real files of the whitelisted modules, never a test file.
  expect(scanned.length).toBeGreaterThan(100);
  expect(scanned.map((s) => s.path)).toEqual(
    expect.arrayContaining([
      join(MODULES, 'catalog/index.ts'),
      join(MODULES, 'catalog/application/item-ref.ts'),
      join(MODULES, 'parsing/application/parsing.ts'),
    ]),
  );
  expect(sources.some((s) => s.path.endsWith('.test.ts'))).toBe(false);
  expect(relayViolations(sources)).toEqual([]);
});

it('[AC-CT-06zt#2][BR-AI-02] 中转扫描自证：值导入别模块再以自己名义导出的各种写法都报出，类型导入、同模块转导出、只用不导出不误报', () => {
  const violating: SourceFile[] = [
    // The relay itself, under its own or another name.
    sample('catalog', 'application/x.ts', `${IMPORT_IS_PLATFORM}export { isPlatform };`),
    sample('catalog', 'application/x.ts', `${IMPORT_IS_PLATFORM}export { isPlatform as isP };`),
    sample('catalog', 'application/x.ts', `${IMPORT_IS_PLATFORM}export const isP = isPlatform;`),
    sample('catalog', 'application/x.ts', `${IMPORT_IS_PLATFORM}export default isPlatform;`),
    sample(
      'catalog',
      'application/x.ts',
      `${IMPORT_IS_PLATFORM}let isP = isPlatform;\nexport { isP as check };`,
    ),
    sample(
      'catalog',
      'application/x.ts',
      `${IMPORT_IS_PLATFORM}const a = isPlatform;\nconst b = a;\nexport const c = b;`,
    ),
    sample(
      'catalog',
      'application/x.ts',
      `${IMPORT_IS_PLATFORM}export const isP = isPlatform as unknown as (p: string) => boolean;`,
    ),
    sample('catalog', 'application/x.ts', `${IMPORT_IS_PLATFORM}export const isP = isPlatform!;`),
    sample(
      'catalog',
      'application/x.ts',
      `${IMPORT_IS_PLATFORM}export const isP = isPlatform.bind(undefined);`,
    ),
    // Wrapped into an exported object, array or fallback.
    sample(
      'catalog',
      'application/x.ts',
      `${IMPORT_IS_PLATFORM}export const api = { isPlatform };`,
    ),
    sample(
      'catalog',
      'application/x.ts',
      `${IMPORT_IS_PLATFORM}export const api = { check: isPlatform };`,
    ),
    sample(
      'catalog',
      'application/x.ts',
      `${IMPORT_IS_PLATFORM}export default Object.freeze({ check: isPlatform });`,
    ),
    sample('catalog', 'application/x.ts', `${IMPORT_IS_PLATFORM}export const all = [isPlatform];`),
    sample(
      'catalog',
      'application/x.ts',
      `${IMPORT_IS_PLATFORM}declare const flag: boolean;\nexport const p = flag ? isPlatform : null;`,
    ),
    sample(
      'catalog',
      'application/x.ts',
      `${IMPORT_IS_PLATFORM}declare const own: unknown;\nexport const p = own ?? isPlatform;`,
    ),
    // Returned by an exported function, arrow or object method.
    sample(
      'catalog',
      'application/x.ts',
      `${IMPORT_IS_PLATFORM}export function get() {\n  return isPlatform;\n}`,
    ),
    sample(
      'catalog',
      'application/x.ts',
      `${IMPORT_IS_PLATFORM}export const get = () => isPlatform;`,
    ),
    sample(
      'catalog',
      'application/x.ts',
      `${IMPORT_IS_PLATFORM}function get() {\n  return isPlatform;\n}\nexport { get };`,
    ),
    sample(
      'catalog',
      'application/x.ts',
      `${IMPORT_IS_PLATFORM}export const api = {\n  get() {\n    return { isPlatform };\n  },\n};`,
    ),
    // Namespace, default and mixed imports; members and destructured parts.
    sample('catalog', 'application/x.ts', `${IMPORT_UNION_NS}export const u = union;`),
    sample('catalog', 'application/x.ts', `${IMPORT_UNION_NS}export const p = union.isPlatform;`),
    sample('catalog', 'application/x.ts', `${IMPORT_UNION_NS}export const { isPlatform } = union;`),
    sample(
      'catalog',
      'application/x.ts',
      `${IMPORT_UNION_NS}const { isPlatform: p } = union;\nexport { p };`,
    ),
    sample('catalog', 'application/x.ts', `import Def from ${UNION};\nexport default Def;`),
    sample(
      'catalog',
      'application/x.ts',
      `import Def, { type UnionItem } from ${UNION};\nexport { Def };\nexport type { UnionItem };`,
    ),
    sample(
      'catalog',
      'application/x.ts',
      `import { type UnionItem, isPlatform as p } from ${UNION};\nexport { p };`,
    ),
    sample('catalog', 'application/x.ts', `import u = require(${UNION});\nexport { u };`),
    sample('catalog', 'application/x.ts', `${IMPORT_UNION_NS}export import p = union.isPlatform;`),
    // Dynamic loads of another module.
    sample('catalog', 'application/x.ts', `export const u = await import(${UNION});`),
    sample('catalog', 'application/x.ts', `export const u = require(${UNION});`),
    // Re-exports from another module, in a non-index file and in index.ts.
    sample('catalog', 'application/x.ts', `export * from ${UNION};`),
    sample('catalog', 'application/x.ts', `export * as union from ${UNION};`),
    sample('catalog', 'application/x.ts', `export { isPlatform } from ${UNION};`),
    sample('catalog', 'index.ts', "export { isPlatform } from '../union/index.ts';"),
    sample(
      'catalog',
      'index.ts',
      "import { isPlatform } from '../union/index.ts';\nexport { isPlatform };",
    ),
    // Any file of another module counts, the read-only entries and non-index files included.
    sample(
      'content',
      'application/x.ts',
      "import { readWallet } from '../../ledger/read.ts';\nexport { readWallet };",
    ),
    sample(
      'parsing',
      'x.ts',
      "import { createGovernor } from '../platform/governance/governor.ts';\nexport { createGovernor };",
    ),
    sample(
      'platform',
      'x.ts',
      "import { createOrderClaim } from '../orders/index.ts';\nexport const claim = createOrderClaim;",
    ),
  ];
  // Every whitelisted module, taolijin (not built yet) included.
  for (const owner of RELAY_MODULES) {
    const from = owner === 'union' ? "'../catalog/index.ts'" : "'../union/index.ts'";
    violating.push(sample(owner, 'x.ts', `import { relayed } from ${from};\nexport { relayed };`));
  }
  for (const file of violating) {
    expect(relayViolations([file]).length, `${file.path}\n${file.text}`).toBeGreaterThan(0);
  }

  const allowed: SourceFile[] = [
    // Types only: `import type`, inline `type`, value import used in type positions.
    sample(
      'catalog',
      'application/x.ts',
      `import type { UnionItem } from ${UNION};\nexport type { UnionItem };\nexport type Item = UnionItem;`,
    ),
    sample(
      'catalog',
      'application/x.ts',
      `import { type UnionItem } from ${UNION};\nexport { type UnionItem };\nexport type { UnionItem as Item };`,
    ),
    sample('catalog', 'application/x.ts', `export type { UnionItem } from ${UNION};`),
    sample('catalog', 'application/x.ts', `export { type UnionItem } from ${UNION};`),
    sample(
      'catalog',
      'application/x.ts',
      `import { UnionError } from ${UNION};\nexport type E = UnionError;\nexport function f(e: UnionError): UnionError {\n  return e;\n}`,
    ),
    // Another module's value used, not handed on: called, constructed, tested against.
    sample(
      'catalog',
      'application/x.ts',
      `${IMPORT_IS_PLATFORM}export function ok(p: string): boolean {\n  return isPlatform(p);\n}`,
    ),
    sample(
      'catalog',
      'application/x.ts',
      `${IMPORT_IS_PLATFORM}export const tb = isPlatform('tb');`,
    ),
    sample(
      'catalog',
      'application/x.ts',
      `import { UnionError } from ${UNION};\nexport const isUnionError = (e: unknown): boolean => e instanceof UnionError;`,
    ),
    sample(
      'catalog',
      'application/x.ts',
      `import { UnionError } from ${UNION};\nexport const fail = (): never => {\n  throw new UnionError('x');\n};`,
    ),
    sample(
      'catalog',
      'application/x.ts',
      `${IMPORT_IS_PLATFORM}const local = isPlatform;\nexport const n = local('jd') ? 1 : 0;`,
    ),
    // Classes are the module's own API (Nest dynamic modules, error subclasses).
    sample(
      'identity',
      'application/x.ts',
      "import { RequestRejection } from '../../platform/index.ts';\nexport class TokenRejection extends RequestRejection {}",
    ),
    sample(
      'catalog',
      'catalog.module.ts',
      "import { CLOCK } from '../platform/index.ts';\nexport class M {\n  static forRoot() {\n    return { providers: [CLOCK] };\n  }\n}",
    ),
    // Relays inside one module: index.ts re-exporting its own files.
    sample('catalog', 'index.ts', "export * from './application/item-ref.ts';"),
    sample('catalog', 'index.ts', "export { search } from './search.ts';"),
    sample(
      'catalog',
      'application/x.ts',
      "import { toRef } from './item-ref.ts';\nexport { toRef };\nexport { fromRef } from '../domain/ref.ts';",
    ),
    // Not another module: packages, node:, files outside apps/api/src/modules/.
    sample('catalog', 'application/x.ts', "import { add } from '@couli/money';\nexport { add };"),
    sample('catalog', 'application/x.ts', "export { randomUUID } from 'node:crypto';"),
    sample(
      'catalog',
      'application/x.ts',
      "import { x } from '../../../common/x.ts';\nexport { x };",
    ),
    // A name that is not the imported binding.
    sample(
      'catalog',
      'application/x.ts',
      `${IMPORT_IS_PLATFORM}const other = 1;\nexport { other };\nexport const n = isPlatform('pdd');`,
    ),
    // Outside the scope of ①: test files, agent itself and modules outside the whitelist.
    sample('catalog', 'application/x.test.ts', `${IMPORT_IS_PLATFORM}export { isPlatform };`),
    sample(
      'agent',
      'tools/x/index.ts',
      "import { parseUrl } from '../../../parsing/index.ts';\nexport { parseUrl };",
    ),
    sample(
      'growth',
      'x.ts',
      "import { isPlatform } from '../union/index.ts';\nexport { isPlatform };",
    ),
  ];
  expect(relayViolations(allowed)).toEqual([]);
});

it('[AC-CT-06zt#3][BR-AI-02] 主干：agent 对只许类型的模块与白名单外模块没有值导入，白名单九个模块没有 import Def, { type T } 混写', () => {
  const sources = moduleSources();
  expect(sources.map((s) => s.path)).toEqual(
    expect.arrayContaining([
      join(MODULES, 'agent/tools/orders/index.ts'),
      join(MODULES, 'catalog/detail.ts'),
    ]),
  );
  expect(mixedImportViolations(sources)).toEqual([]);
});

it('[AC-CT-06zt#4][BR-AI-02] 混写扫描自证：默认导入夹带行内 type 等值导入都报出，纯类型导入、可取值模块与只读入口不误报', () => {
  const agent = (specifier: string, clause: string): SourceFile =>
    sample('agent', 'tools/x/index.ts', `import ${clause} from '../../../${specifier}';`);
  const violating: SourceFile[] = [];
  // agent toward each types-only module: the mixed form and every other value binding.
  for (const target of TYPE_ONLY_MODULES) {
    const index = `${target}/index.ts`;
    violating.push(
      agent(index, 'Def, { type T }'),
      agent(index, 'Def, { type T, type U }'),
      agent(index, 'Def'),
      agent(index, '* as ns'),
      agent(index, 'Def, * as ns'),
      agent(index, '{ value }'),
      agent(index, '{ type T, value }'),
      agent(index, '{ value as other }'),
      agent(`${target}/application/x.ts`, 'Def, { type T }'),
    );
  }
  // agent toward modules and files outside the whitelist.
  for (const specifier of [
    'growth/index.ts',
    'commission/index.ts',
    'settlement/index.ts',
    'risk/index.ts',
    'ledger/index.ts',
    'ledger/application/x.ts',
    'payout/index.ts',
    'payout/application/read.ts',
  ]) {
    violating.push(agent(specifier, 'Def, { type T }'), agent(specifier, '{ value }'));
  }
  violating.push(
    sample('agent', 'tools/x/index.ts', "import '../../../orders/index.ts';"),
    sample(
      'agent',
      'tools/x/index.ts',
      "export { default as D, type T } from '../../../orders/index.ts';",
    ),
    sample('agent', 'tools/x/index.ts', "export * from '../../../union/index.ts';"),
    sample('agent', 'tools/x/index.ts', "export * as ns from '../../../identity/index.ts';"),
    sample(
      'agent',
      'stream/mount/x.ts',
      "import Def, {\n  type OrderSubject,\n  type OwnOrderNumberQuery,\n} from '../../../orders/index.ts';",
    ),
  );
  // The nine whitelisted modules: the mixed form toward the same targets, index.ts included.
  violating.push(
    sample('catalog', 'x.ts', "import Def, { type UnionItem } from '../union/index.ts';"),
    sample('catalog', 'index.ts', "import Def, { type UnionItem } from '../union/index.ts';"),
    sample('parsing', 'application/x.ts', "import Def, { type T } from '../../orders/index.ts';"),
    sample('content', 'x.ts', "import Def, { type T, value } from '../identity/index.ts';"),
    sample('platform', 'x.ts', "import Def, { type T } from '../linking/application/x.ts';"),
    sample('taolijin', 'x.ts', "import Def, { type T } from '../growth/index.ts';"),
    sample('union', 'x.ts', "import Def, { type T } from '../risk/index.ts';"),
    sample('identity', 'x.ts', "import Def, { type T } from '../ledger/index.ts';"),
    sample('orders', 'x.ts', "import Def, { type T } from '../payout/index.ts';"),
    sample('linking', 'x.ts', "import Def, { type T } from '../commission/index.ts';"),
  );
  for (const file of violating) {
    expect(mixedImportViolations([file]).length, `${file.path}\n${file.text}`).toBeGreaterThan(0);
  }

  const allowed: SourceFile[] = [
    // agent: types only toward the types-only modules.
    agent('orders/index.ts', 'type Def'),
    agent('orders/index.ts', 'type { T, U }'),
    agent('linking/index.ts', 'type * as ns'),
    agent('identity/index.ts', '{ type T, type U }'),
    agent('union/index.ts', '{ type T as U }'),
    sample('agent', 'tools/x/index.ts', "export type { T } from '../../../orders/index.ts';"),
    sample('agent', 'tools/x/index.ts', "export { type T } from '../../../linking/index.ts';"),
    // agent: value imports from the value modules and the two read-only entries.
    agent('parsing/index.ts', 'Def, { type T, parseUrl }'),
    agent('catalog/index.ts', 'Def, { type T }'),
    agent('content/index.ts', '* as content'),
    agent('taolijin/index.ts', 'Def, { type T }'),
    agent('platform/index.ts', '{ CLOCK, type Clock }'),
    agent('ledger/read.ts', '{ readWallet }'),
    agent('payout/read.ts', '{ listMyWithdrawals, type T }'),
    // agent's own tools/orders directory is not the orders module.
    sample('agent', 'tools/claim/x.ts', "import Def, { type T } from '../orders/index.ts';"),
    // Whitelisted modules may value-import; only the mixed default form is ②'s.
    sample('catalog', 'x.ts', "import { isPlatform, type UnionItem } from '../union/index.ts';"),
    sample('catalog', 'x.ts', "import Def from '../union/index.ts';"),
    sample('catalog', 'x.ts', "import Def, { isPlatform } from '../union/index.ts';"),
    sample('catalog', 'x.ts', "import * as union from '../union/index.ts';"),
    sample('catalog', 'x.ts', "import Def, { type Clock } from '../platform/index.ts';"),
    sample('linking', 'x.ts', "import Def, { type T } from '../parsing/index.ts';"),
    sample('orders', 'domain/x.ts', "import Def, { type T } from '../application/x.ts';"),
    // Outside the scope of ②: test files and modules outside the whitelist.
    sample(
      'agent',
      'tools/x/index.test.ts',
      "import Def, { type T } from '../../../orders/index.ts';",
    ),
    sample('growth', 'x.ts', "import Def, { type T } from '../orders/index.ts';"),
    sample('ledger', 'x.ts', "import Def, { type T } from '../identity/index.ts';"),
  ];
  expect(mixedImportViolations(allowed)).toEqual([]);
});
