// Smoke test of the five built process entries. Requires a prior build (`pnpm build`).
//   node scripts/smoke-entries.ts
// Phase 1: every entry runs `node dist/main.<entry>.js` with APP_ENV=test and
//   COULI_EXIT_AFTER_INIT=1 and must exit 0 within the time limit after logging one
//   structured `started` line. No port is opened.
// Phase 2: the two non-HTTP entries run without COULI_EXIT_AFTER_INIT, must stay alive after
//   `started`, and must exit 0 with a `stopped` line after SIGTERM.
// Exit codes: 0 ok, 1 a check failed, 2 build output missing.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRIES = ['api', 'stream', 'admin', 'worker', 'payout'] as const;
const SIGNAL_ENTRIES = ['worker', 'payout'] as const;
const LIMIT_MS = 5_000;
const STAY_ALIVE_MS = 300;

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const distFile = (entry: string): string => join(appDir, 'dist', `main.${entry}.js`);

// A minimal environment: nothing from the caller can change the outcome (for example a
// credential-looking variable or CLOCK_NOW in the developer's shell).
function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { APP_ENV: 'test', LOG_LEVEL: 'info', ...extra };
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
    env: childEnv({ COULI_EXIT_AFTER_INIT: '1' }),
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

function checkSignalShutdown(entry: string): Promise<void> {
  return new Promise((resolve) => {
    const began = performance.now();
    const child = spawn(process.execPath, [distFile(entry)], {
      cwd: appDir,
      env: childEnv({}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let signalled = false;
    let exitedEarly = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (!signalled && hasLine(stdout, entry, 'started')) {
        signalled = true;
        // The process must still be running a moment after `started`.
        setTimeout(() => {
          if (child.exitCode !== null || child.signalCode !== null) exitedEarly = true;
          child.kill('SIGTERM');
        }, STAY_ALIVE_MS);
      }
    });
    const limit = setTimeout(() => child.kill('SIGKILL'), LIMIT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(limit);
      const elapsed = Math.round(performance.now() - began);
      const problems: string[] = [];
      if (!signalled) problems.push('no "started" line');
      if (exitedEarly) problems.push('exited before SIGTERM was sent');
      if (signal !== null) problems.push(`killed by ${signal} (limit ${LIMIT_MS} ms)`);
      if (code !== 0) problems.push(`exit code ${String(code)}`);
      if (!hasLine(stdout, entry, 'stopped')) problems.push('no "stopped" line');
      if (stderr.trim() !== '') problems.push(`stderr not empty: ${stderr.trim()}`);
      if (problems.length === 0) {
        console.error(`ok   ${entry.padEnd(6)} sigterm          ${elapsed} ms`);
      } else {
        console.error(`FAIL ${entry.padEnd(6)} sigterm          ${problems.join('; ')}`);
        failures.push(entry);
      }
      resolve();
    });
  });
}

const missing = ENTRIES.filter((entry) => !existsSync(distFile(entry)));
if (missing.length > 0) {
  console.error(
    `smoke:entries: build output missing for: ${missing.join(', ')}. Run \`pnpm build\` first.`,
  );
  process.exit(2);
}

for (const entry of ENTRIES) checkExitAfterInit(entry);
for (const entry of SIGNAL_ENTRIES) await checkSignalShutdown(entry);

if (failures.length > 0) {
  console.error(`smoke:entries: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.error('smoke:entries: all entries ok');
