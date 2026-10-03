// Base contract for the oasdiff breaking-change check (workflow contracts.yml, 规划/04 §5「兼容」):
// reads the base copy of contracts/openapi.yaml and writes it as JSON without the operations
// marked `x-implementation: planned`. A planned operation has no route and no caller yet
// (contracts/README.md rule 10; apps/api/src/contract.test.ts), so no client can depend on its
// request or response shape; in the head contract it shows up as a new operation, which oasdiff
// does not count as breaking. Once an operation ships (the marker is removed) every later change
// to it is compared as before. A path left without operations is dropped as well.
//
//   node tools/ci/oasdiff-base.ts <base openapi.yaml> <output .json>
//
// Exit codes: 0 written, 2 usage or unreadable input.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseYamlLite } from '../lib/yaml-lite.ts';

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'] as const;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Returns a copy of the document without planned operations, and the operations removed. */
export function stripPlanned(doc: unknown): { doc: Obj; removed: string[] } {
  if (!isObj(doc) || !isObj(doc['paths'])) throw new Error('not an OpenAPI document with paths');
  const copy = structuredClone(doc);
  const paths = copy['paths'] as Obj;
  const removed: string[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!isObj(item)) continue;
    for (const method of METHODS) {
      const op = item[method];
      if (isObj(op) && op['x-implementation'] === 'planned') {
        delete item[method];
        removed.push(`${method.toUpperCase()} ${path}`);
      }
    }
    if (!METHODS.some((m) => isObj(item[m]))) delete paths[path];
  }
  return { doc: copy, removed };
}

function main(argv: string[]): number {
  const [input, output, ...rest] = argv;
  if (input === undefined || output === undefined || rest.length > 0) {
    console.error('usage: node tools/ci/oasdiff-base.ts <base openapi.yaml> <output .json>');
    return 2;
  }
  let parsed: unknown;
  try {
    parsed = parseYamlLite(readFileSync(input, 'utf8'));
  } catch (err) {
    console.error(`oasdiff-base: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const { doc, removed } = stripPlanned(parsed);
  writeFileSync(output, `${JSON.stringify(doc, null, 2)}\n`);
  console.error(
    `oasdiff-base: ${String(removed.length)} planned operation(s) left out of the base: ` +
      (removed.join(', ') || 'none'),
  );
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
