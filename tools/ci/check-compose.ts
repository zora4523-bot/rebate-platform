// Static check for the compose files under infra/ (CT-06zh): every long-running service, i.e.
// one with a `restart` policy other than "no", must declare hard resource caps (`cpus`,
// `mem_limit`, `pids_limit`) and a working `healthcheck` (a `test`, not `disable: true`).
//
// Usage: node tools/ci/check-compose.ts [--root <repo dir>] [--json]
// Exit codes: 0 ok, 1 violations, 2 usage or internal error (including a file that does not
// parse: it is reported, never skipped).
//
// Scans infra/**/compose.yaml and infra/**/compose.*.yaml with tools/lib/yaml-lite.ts.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseYamlLite } from '../lib/yaml-lite.ts';

export type Problem = { file: string; service: string; key: string; message: string };

export class ComposeParseError extends Error {
  constructor(file: string, cause: unknown) {
    super(`${file}: ${(cause as Error).message ?? String(cause)}`);
    this.name = 'ComposeParseError';
  }
}

const INFRA_DIR = 'infra';
const COMPOSE_FILE = /^compose(\.[\w-]+)?\.yaml$/;
const REQUIRED_KEYS = ['cpus', 'mem_limit', 'pids_limit', 'healthcheck'] as const;

/** Directory prefixes (relative to the repo root) whose compose files are skipped entirely. */
const ALLOWLIST: readonly string[] = [
  // k6 / WireMock load-test tools: one-shot containers started by hand for a test run.
  'infra/load/',
  // Fault-injection drills: one-shot containers that live only for the drill.
  'infra/fault/',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Repo-relative paths of every compose file under infra/, sorted. */
export function findComposeFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (rel: string): void => {
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) walk(path);
      } else if (entry.isFile() && COMPOSE_FILE.test(entry.name)) {
        found.push(path);
      }
    }
  };
  walk(INFRA_DIR);
  return found.sort();
}

function isAllowlisted(file: string): boolean {
  return ALLOWLIST.some((prefix) => file.startsWith(prefix));
}

/** A service is long-running when it has a restart policy other than "no". */
function isLongRunning(service: Record<string, unknown>): boolean {
  if (!('restart' in service)) return false;
  const restart = service['restart'];
  // `restart: no` unquoted is the boolean false in YAML 1.1.
  return restart !== 'no' && restart !== false && restart !== null;
}

/** A healthcheck counts only when it has a non-empty `test` and is not disabled. */
function hasWorkingHealthcheck(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value['disable'] === true) return false;
  const test = value['test'];
  if (Array.isArray(test)) return test.length > 0 && test[0] !== 'NONE';
  return typeof test === 'string' && test.trim() !== '';
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/** Checks one compose file's text; throws ComposeParseError when it cannot be read as compose. */
export function checkComposeText(file: string, text: string): Problem[] {
  let doc: unknown;
  try {
    doc = parseYamlLite(text);
  } catch (error) {
    throw new ComposeParseError(file, error);
  }
  if (!isRecord(doc)) throw new ComposeParseError(file, new Error('top level is not a mapping'));
  const services = doc['services'];
  if (services === undefined) return [];
  if (!isRecord(services)) {
    throw new ComposeParseError(file, new Error('`services` is not a mapping'));
  }
  const problems: Problem[] = [];
  for (const [name, service] of Object.entries(services)) {
    if (!isRecord(service)) {
      throw new ComposeParseError(file, new Error(`service \`${name}\` is not a mapping`));
    }
    if (!isLongRunning(service)) continue;
    for (const key of REQUIRED_KEYS) {
      const ok =
        key === 'healthcheck' ? hasWorkingHealthcheck(service[key]) : isPresent(service[key]);
      if (!ok) problems.push({ file, service: name, key, message: `${file}:${name}: 缺 ${key}` });
    }
  }
  return problems;
}

export function checkCompose(root: string): Problem[] {
  return findComposeFiles(root)
    .filter((file) => !isAllowlisted(file))
    .flatMap((file) => checkComposeText(file, readFileSync(join(root, file), 'utf8')));
}

function main(argv: string[]): number {
  let root = resolve(import.meta.dirname, '../..');
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--root' && argv[i + 1] !== undefined) {
      root = resolve(argv[++i] ?? '.');
    } else {
      console.error('usage: node tools/ci/check-compose.ts [--root <repo dir>] [--json]');
      return 2;
    }
  }
  let problems: Problem[];
  try {
    problems = checkCompose(root);
  } catch (error) {
    if (!(error instanceof ComposeParseError)) throw error;
    if (json) console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
    console.error(`check-compose: cannot parse ${error.message}`);
    return 2;
  }
  if (json) console.log(JSON.stringify({ ok: problems.length === 0, problems }, null, 2));
  for (const p of problems) console.error(p.message);
  console.error(
    problems.length === 0 ? 'check-compose: ok' : `check-compose: ${problems.length} problem(s)`,
  );
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`check-compose: internal error: ${(error as Error).stack ?? String(error)}`);
    process.exitCode = 2;
  }
}
