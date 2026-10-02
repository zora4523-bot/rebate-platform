// Generates the TypeScript view of contracts/:
//   src/openapi.gen.ts       from contracts/openapi.yaml (openapi-typescript)
//   src/enums.gen.ts         from contracts/enums/*.yaml
//   src/error-codes.gen.ts   from contracts/error-codes.yaml
//   node scripts/codegen.ts           write the generated files
//   node scripts/codegen.ts --check   exit 1 when a committed file differs from a fresh run
// Both modes first run the cross-file conformance checks (conformance.ts) and stop on a problem.
// Works offline: the contract has no remote $ref and openapi-typescript does not phone home.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';
import { loadEnums, loadErrorCodes, renderEnums, renderErrorCodes } from './catalog.ts';
import { checkConformance } from './conformance.ts';
import {
  enumsGeneratedFile,
  errorCodesGeneratedFile,
  generatedFile,
  openapiFile,
  repoRoot,
} from './paths.ts';

function header(source: string): string {
  return [
    '// GENERATED FILE. Do not edit by hand.',
    `// Source: ${source}`,
    '// Regenerate: pnpm contracts:codegen (drift is checked by pnpm contracts:check)',
    '',
    '',
  ].join('\n');
}

async function renderOpenapi(): Promise<string> {
  const ast = await openapiTS(pathToFileURL(openapiFile), { silent: true });
  return header('contracts/openapi.yaml') + astToString(ast);
}

const args = process.argv.slice(2);
const check = args.includes('--check');
const unknown = args.filter((arg) => arg !== '--check');
if (unknown.length > 0) {
  console.error(`codegen: unknown argument(s): ${unknown.join(' ')}`);
  console.error('usage: node scripts/codegen.ts [--check]');
  process.exit(2);
}

let outputs: Array<{ file: string; content: string }>;
try {
  const errors = loadErrorCodes();
  const enumDefs = loadEnums();
  const problems = checkConformance(enumDefs, errors.codes);
  if (problems.length > 0) {
    for (const p of problems) console.error(`codegen: conformance: ${p}`);
    process.exit(1);
  }
  outputs = [
    { file: generatedFile, content: await renderOpenapi() },
    {
      file: enumsGeneratedFile,
      content: header('contracts/enums/*.yaml') + renderEnums(enumDefs),
    },
    {
      file: errorCodesGeneratedFile,
      content: header('contracts/error-codes.yaml') + renderErrorCodes(errors.codes, errors.ranges),
    },
  ];
} catch (err) {
  console.error(`codegen: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

let stale = 0;
for (const { file, content } of outputs) {
  const target = relative(repoRoot, file);
  if (!check) {
    writeFileSync(file, content);
    console.error(`codegen: wrote ${target}`);
    continue;
  }
  const committed = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  if (committed === content) {
    console.error(`codegen: ${target} is up to date`);
    continue;
  }
  stale++;
  const freshFile = join(mkdtempSync(join(tmpdir(), 'couli-codegen-')), basename(file));
  writeFileSync(freshFile, content);
  console.error(
    committed === undefined
      ? `codegen: ${target} is missing.`
      : `codegen: ${target} differs from what contracts/ generates.`,
  );
  console.error(`codegen: fresh output kept at ${freshFile}`);
}
if (stale > 0) {
  console.error('codegen: run `pnpm contracts:codegen` and commit the result.');
  process.exit(1);
}
