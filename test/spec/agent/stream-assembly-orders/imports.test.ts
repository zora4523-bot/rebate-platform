// B3-08g · BR-AI-02 ③ (orders / linking part, as the B3-08g brief writes it): agent reaches orders'
// read-only queries and linking's link_logs reader only through ports app.module assembles. agent's
// own code may name orders / linking only through their index.ts and only with `import type`; it
// never names the composition root's factories or the B-level operations. Static scan over the
// TypeScript AST of apps/api/src/modules/agent/** (test files excluded); no database.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import ts from 'typescript';
import {
  AGENT,
  APP_MODULE,
  agentSources,
  calledNames,
  importViolations,
  type SourceFile,
} from './scan.ts';

function sample(path: string, text: string): SourceFile {
  return { path: join(AGENT, path), text };
}

function importsOf(text: string): { specifier: string; names: string[]; typeOnly: boolean }[] {
  const source = ts.createSourceFile('app.module.ts', text, ts.ScriptTarget.Latest, true);
  const out: { specifier: string; names: string[]; typeOnly: boolean }[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    const names =
      bindings !== undefined && ts.isNamedImports(bindings)
        ? bindings.elements.filter((e) => !e.isTypeOnly).map((e) => e.name.text)
        : [];
    out.push({
      specifier: statement.moduleSpecifier.text,
      names,
      typeOnly: statement.importClause?.isTypeOnly === true,
    });
  }
  return out;
}

it('[AC-B3-08g#4][BR-AI-02] agent/** 只以 import type 引 orders、linking 的 index.ts，不出现 createOrderQueries / createClaimEntryReader / createOrderClaim / createClaim / openLink；两者由组装根 app.module 创建', () => {
  // The composition root builds the agent's order queries and link_logs reader (B3-03j precedent).
  const root = readFileSync(APP_MODULE, 'utf8');
  const called = calledNames(APP_MODULE, root);
  expect(called.has('createOrderQueries'), 'app.module calls createOrderQueries').toBe(true);
  expect(called.has('createClaimEntryReader'), 'app.module calls createClaimEntryReader').toBe(
    true,
  );
  const imports = importsOf(root);
  const fromOrders = imports.filter((i) => i.specifier === './modules/orders/index.ts');
  expect(fromOrders.some((i) => !i.typeOnly && i.names.includes('createOrderQueries'))).toBe(true);

  // agent's own code (production sources only).
  const sources = agentSources();
  expect(sources.length).toBeGreaterThan(0);
  expect(sources.map((s) => s.path)).toEqual(
    expect.arrayContaining([join(AGENT, 'stream/mount/orders.ts')]),
  );
  expect(importViolations(sources)).toEqual([]);

  // The scan itself: each kind of violation is reported, an allowed type import is not.
  const allowed = [
    sample('tools/x/index.ts', "import type { OrderSubject } from '../../../orders/index.ts';"),
    sample('tools/x/index.ts', "export type { ClaimEntryLog } from '../../../linking/index.ts';"),
    // agent's own tools/orders directory is not the orders module.
    sample('tools/claim/x.ts', "import { createListMyOrdersHandler } from '../orders/index.ts';"),
  ];
  expect(importViolations(allowed)).toEqual([]);
  const violating = [
    sample('stream/mount/x.ts', "import { createOrderQueries } from '../../../orders/index.ts';"),
    sample(
      'stream/mount/x.ts',
      "import { type OrderSubject } from '../../../orders/index.ts';\nexport type A = OrderSubject;",
    ),
    sample(
      'tools/x/index.ts',
      "import type { OrderQueryDeps } from '../../../orders/application/order-queries.ts';",
    ),
    sample('tools/x/index.ts', "import * as linking from '../../../linking/index.ts';"),
    sample(
      'tools/x/index.ts',
      "export { createClaimEntryReader } from '../../../linking/index.ts';",
    ),
    sample('tools/x/index.ts', "const m = await import('../../../linking/index.ts');"),
    sample('tools/x/index.ts', "const m = require('../../../orders/index.ts');"),
    sample(
      'tools/x/index.ts',
      'export async function f(p: { openLink(): void }) { p.openLink(); }',
    ),
    sample('tools/x/index.ts', 'declare const ports: { createClaim(): void };'),
    sample('tools/x/index.ts', 'export const create = (d: unknown) => createOrderClaim(d);'),
  ];
  for (const file of violating) {
    expect(importViolations([file]).length, file.text).toBeGreaterThan(0);
  }
});
