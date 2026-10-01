// Generates src/openapi.gen.ts from contracts/openapi.yaml with openapi-typescript.
//   node scripts/codegen.ts           write the generated file
//   node scripts/codegen.ts --check   exit 1 when the committed file differs from a fresh run
// Works offline: the contract has no remote $ref and openapi-typescript does not phone home.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';
import { generatedFile, openapiFile, repoRoot } from './paths.ts';

const HEADER = [
  '// GENERATED FILE. Do not edit by hand.',
  '// Source: contracts/openapi.yaml',
  '// Regenerate: pnpm contracts:codegen (drift is checked by pnpm contracts:check)',
  '',
  '',
].join('\n');

async function render(): Promise<string> {
  const ast = await openapiTS(pathToFileURL(openapiFile), { silent: true });
  return HEADER + astToString(ast);
}

const args = process.argv.slice(2);
const check = args.includes('--check');
const unknown = args.filter((arg) => arg !== '--check');
if (unknown.length > 0) {
  console.error(`codegen: unknown argument(s): ${unknown.join(' ')}`);
  console.error('usage: node scripts/codegen.ts [--check]');
  process.exit(2);
}

const fresh = await render();
const target = relative(repoRoot, generatedFile);

if (!check) {
  writeFileSync(generatedFile, fresh);
  console.error(`codegen: wrote ${target}`);
} else {
  const committed = existsSync(generatedFile) ? readFileSync(generatedFile, 'utf8') : undefined;
  if (committed === fresh) {
    console.error(`codegen: ${target} is up to date`);
  } else {
    const freshFile = join(mkdtempSync(join(tmpdir(), 'couli-codegen-')), 'openapi.gen.ts');
    writeFileSync(freshFile, fresh);
    console.error(
      committed === undefined
        ? `codegen: ${target} is missing.`
        : `codegen: ${target} differs from what contracts/openapi.yaml generates.`,
    );
    console.error(`codegen: fresh output kept at ${freshFile}`);
    console.error('codegen: run `pnpm contracts:codegen` and commit the result.');
    process.exit(1);
  }
}
