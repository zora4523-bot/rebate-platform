// Node-side helpers: the planned operationIds read straight from contracts/openapi.yaml (never a
// hand-written list) and the exports of a generated file evaluated from its source text.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect } from 'vitest';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';

export const OPENAPI = 'contracts/openapi.yaml';
export const GENERATED = 'packages/contracts-ts/src/planned-operations.gen.ts';
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Resolved from the module's own directory, not `new URL(…, import.meta.url)`: under jsdom Vite
// rewrites that form into an http://localhost URL.
const HERE = dirname(fileURLToPath(import.meta.url));

export function repoPath(path: string): string {
  return resolve(HERE, '../../../..', path);
}

/** A missing asset is an assertion failure, never an ENOENT. */
export function requiredText(path: string): string {
  const file = repoPath(path);
  expect(existsSync(file), `missing ${path}`).toBe(true);
  return readFileSync(file, 'utf8');
}

/** Sorted operationIds of every operation under `paths` with `x-implementation: planned`. */
export function plannedOf(source: string): string[] {
  const doc = parseYamlLite(source);
  expect(isObj(doc), 'openapi.yaml is a mapping').toBe(true);
  const paths = (doc as Obj)['paths'];
  expect(isObj(paths), 'openapi.yaml has paths').toBe(true);
  const ids: string[] = [];
  for (const item of Object.values(paths as Obj)) {
    if (!isObj(item)) continue;
    for (const method of METHODS) {
      const operation = item[method];
      if (!isObj(operation) || operation['x-implementation'] !== 'planned') continue;
      const id = operation['operationId'];
      expect(typeof id, 'planned operation has an operationId').toBe('string');
      ids.push(String(id));
    }
  }
  return ids.sort();
}

export function plannedFromContract(): string[] {
  return plannedOf(requiredText(OPENAPI));
}

/**
 * Exports of a generated TypeScript file, evaluated in an isolated context. The generated list
 * stands alone: no runtime import of another module.
 */
export function generatedExports(source: string): Record<string, unknown> {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  expect(compiled.diagnostics ?? []).toEqual([]);
  expect(/\brequire\(/.test(compiled.outputText), 'no runtime import in the generated list').toBe(
    false,
  );
  const exports: Record<string, unknown> = {};
  runInNewContext(compiled.outputText, { exports, module: { exports } }, { timeout: 1000 });
  return exports;
}

/**
 * Every exported Set or array of strings, each sorted. The export name and the collection kind are
 * the generator's choice; the members are what the contract says.
 */
export function stringLists(exports: Record<string, unknown>): string[][] {
  const lists: string[][] = [];
  for (const value of Object.values(exports)) {
    const kind = Object.prototype.toString.call(value);
    if (kind !== '[object Set]' && kind !== '[object Array]') continue;
    const items: unknown[] = Array.from(value as Iterable<unknown>);
    if (items.length === 0 || !items.every((item) => typeof item === 'string')) continue;
    lists.push((items as string[]).slice().sort());
  }
  return lists;
}
