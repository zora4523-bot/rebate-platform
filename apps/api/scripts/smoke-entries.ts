// Smoke test of the five built process entries. Requires a prior build (`pnpm build`).
//   node scripts/smoke-entries.ts
// Phase 1: every entry runs `node dist/main.<entry>.js` with APP_ENV=test and
//   COULI_EXIT_AFTER_INIT=1 and must exit 0 within the time limit after logging one
//   structured `started` line. No port is opened.
// Phase 2: the two non-HTTP entries run without COULI_EXIT_AFTER_INIT against an unreachable
//   database and must exit 1 with `startup_failed`, no `started`, and no password in output.
//   Signal shutdown with a reachable database is covered by the queue entry integration tests.
// Exit codes: 0 ok, 1 a check failed, 2 build output missing.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRIES = ['api', 'stream', 'admin', 'worker', 'payout'] as const;
const QUEUE_ENTRIES = ['worker', 'payout'] as const;
const LIMIT_MS = 5_000;

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const distFile = (entry: string): string => join(appDir, 'dist', `main.${entry}.js`);

// A minimal environment: nothing from the caller can change the outcome (for example a
// credential-looking variable or CLOCK_NOW in the developer's shell).
function childEnv(entry: string, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {
    APP_ENV: 'test',
    LOG_LEVEL: 'info',
    DATABASE_URL: `postgres://${entry === 'payout' ? 'couli_payout' : 'couli_app'}@127.0.0.1:1/couli`,
    ...(entry === 'worker'
      ? { DATABASE_MAINT_URL: 'postgres://couli_maint@127.0.0.1:1/couli' }
      : {}),
    ...(entry === 'admin'
      ? { DATABASE_READ_URL: 'postgres://couli_readonly@127.0.0.1:1/couli' }
      : {}),
    ...(entry === 'payout' ? {} : { REDIS_URL: 'redis://127.0.0.1:1/0' }),
    ...extra,
  };
  for (const name of ['PATH', 'HOME', 'TMPDIR']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

interface LogLine {
  msg?: unknown;
  entry?: unknown;
  listening?: unknown;
  problems?: unknown;
}

function logLines(stdout: string): LogLine[] {
  const lines: LogLine[] = [];
  for (const text of stdout.split('\n')) {
    if (text.trim() === '') continue;
    try {
      lines.push(JSON.parse(text) as LogLine);
    } catch {
      lines.push({ msg: `(not JSON) ${text}` });
    }
  }
  return lines;
}

function hasLine(stdout: string, entry: string, msg: string): boolean {
  return logLines(stdout).some((line) => line.msg === msg && line.entry === entry);
}

const failures: string[] = [];

function checkExitAfterInit(entry: string): void {
  const began = performance.now();
  const result = spawnSync(process.execPath, [distFile(entry)], {
    cwd: appDir,
    env: childEnv(entry, { COULI_EXIT_AFTER_INIT: '1' }),
    encoding: 'utf8',
    timeout: LIMIT_MS,
  });
  const elapsed = Math.round(performance.now() - began);
  const problems: string[] = [];
  if (result.error !== undefined) problems.push(`spawn error: ${result.error.message}`);
  if (result.signal !== null) problems.push(`killed by ${result.signal} (limit ${LIMIT_MS} ms)`);
  if (result.status !== 0) problems.push(`exit code ${String(result.status)}`);
  const started = logLines(result.stdout).filter(
    (line) => line.msg === 'started' && line.entry === entry,
  );
  if (started.length !== 1) problems.push(`expected 1 "started" line, found ${started.length}`);
  if (started[0] !== undefined && started[0].listening !== false) {
    problems.push('"started" line does not say listening=false');
  }
  if (logLines(result.stdout).some((line) => String(line.msg).startsWith('(not JSON)'))) {
    problems.push('stdout contains non-JSON output');
  }
  if (result.stderr.trim() !== '') problems.push(`stderr not empty: ${result.stderr.trim()}`);

  if (problems.length === 0) {
    console.error(`ok   ${entry.padEnd(6)} exit-after-init  ${elapsed} ms`);
  } else {
    console.error(`FAIL ${entry.padEnd(6)} exit-after-init  ${problems.join('; ')}`);
    failures.push(entry);
  }
}

function checkDatabaseUnavailable(entry: string): void {
  const began = performance.now();
  // A synthetic password checks both decoded and URL-encoded credential leakage.
  const password = 'smoke-only:queue-password';
  const encodedPassword = encodeURIComponent(password);
  const result = spawnSync(process.execPath, [distFile(entry)], {
    cwd: appDir,
    env: childEnv(entry, {
      DATABASE_URL: `postgres://${entry === 'payout' ? 'couli_payout' : 'couli_app'}:${encodedPassword}@127.0.0.1:1/couli`,
    }),
    encoding: 'utf8',
    timeout: LIMIT_MS,
  });
  const elapsed = Math.round(performance.now() - began);
  const problems: string[] = [];
  if (result.error !== undefined) problems.push('spawn error');
  if (result.signal !== null) problems.push(`killed by ${result.signal} (limit ${LIMIT_MS} ms)`);
  if (result.status !== 1) problems.push(`expected exit code 1, got ${String(result.status)}`);
  if (!hasLine(result.stdout, entry, 'startup_failed')) problems.push('no "startup_failed" line');
  const lines = logLines(result.stdout);
  if (lines.some((line) => line.msg === 'started')) problems.push('unexpected "started" line');
  if (lines.some((line) => String(line.msg).startsWith('(not JSON)'))) {
    problems.push('stdout contains non-JSON output');
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (output.includes(password) || output.includes(encodedPassword)) {
    problems.push('output contains database password');
  }
  // Do not echo child output: it could contain the very credential leak being checked.
  if (result.stderr.trim() !== '') problems.push('stderr not empty');
  if (problems.length === 0) {
    console.error(`ok   ${entry.padEnd(6)} db-unavailable   ${elapsed} ms`);
  } else {
    console.error(`FAIL ${entry.padEnd(6)} db-unavailable   ${problems.join('; ')}`);
    failures.push(entry);
  }
}

const missing = ENTRIES.filter((entry) => !existsSync(distFile(entry)));
if (missing.length > 0) {
  console.error(
    `smoke:entries: build output missing for: ${missing.join(', ')}. Run \`pnpm build\` first.`,
  );
  process.exit(2);
}

function checkMissingVariables(entry: string): void {
  const required = [
    'DATABASE_URL',
    ...(entry === 'admin' ? ['DATABASE_READ_URL'] : []),
    ...(entry === 'payout' ? [] : ['REDIS_URL']),
    ...(entry === 'worker' ? ['DATABASE_MAINT_URL'] : []),
  ];
  for (const name of required) {
    const env = childEnv(entry, { COULI_EXIT_AFTER_INIT: '1' });
    // Only APP_ENV=test permits workers without a maintenance connection.
    if (name === 'DATABASE_MAINT_URL') env['APP_ENV'] = 'local';
    delete env[name];
    const result = spawnSync(process.execPath, [distFile(entry)], {
      cwd: appDir,
      env,
      encoding: 'utf8',
      timeout: LIMIT_MS,
    });
    const lines = logLines(result.stdout);
    if (
      result.status !== 1 ||
      result.error !== undefined ||
      result.signal !== null ||
      result.stderr.trim() !== '' ||
      lines.length !== 1 ||
      lines[0]?.msg !== 'config_invalid' ||
      lines[0]?.entry !== entry ||
      JSON.stringify(lines[0]?.problems) !==
        JSON.stringify([`${name}: must be set for the ${entry} entry`])
    ) {
      console.error(`FAIL ${entry} missing ${name}`);
      failures.push(`${entry}/${name}`);
    } else {
      console.error(`ok   ${entry.padEnd(6)} missing ${name}`);
    }
  }
}

for (const entry of ENTRIES) checkExitAfterInit(entry);
for (const entry of ENTRIES) checkMissingVariables(entry);
for (const entry of QUEUE_ENTRIES) checkDatabaseUnavailable(entry);

if (failures.length > 0) {
  console.error(`smoke:entries: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.error('smoke:entries: all entries ok');
