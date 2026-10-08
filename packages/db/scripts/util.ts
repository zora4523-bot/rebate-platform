// Small helpers shared by the scripts in this directory.
import { describeError, redactCredentials } from '../src/pg-url.ts';

/** Command-line arguments without the `--` separator that pnpm passes through. */
export function cliArgs(): string[] {
  return process.argv.slice(2).filter((arg) => arg !== '--');
}

/** Progress output (stderr). Connection passwords are masked here as well (redactCredentials). */
export function info(message: string): void {
  console.error(redactCredentials(message));
}

/** A failure with a message for the owner; `main` prints it and exits with `code`. */
export class ScriptError extends Error {
  readonly code: 1 | 2;

  constructor(message: string, code: 1 | 2) {
    super(message);
    this.name = 'ScriptError';
    this.code = code;
  }
}

/**
 * Aborts the script: 1 = a check failed, 2 = usage or internal error. Throws instead of
 * exiting so that `finally` blocks (dropping throwaway databases, stopping containers) run.
 */
export function fail(message: string, code: 1 | 2 = 2): never {
  throw new ScriptError(message, code);
}

export function requireEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    fail(`缺少环境变量 ${name}。${hint}`);
  }
  return value;
}

/** Runs the script body; every script goes through this so failures map to exit codes. */
export async function main(run: () => Promise<void> | void): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ScriptError) {
      console.error(`错误：${redactCredentials(error.message)}`);
      process.exitCode = error.code;
      return;
    }
    // Never console.error(error): see describeError (src/pg-url.ts).
    console.error(`错误：${describeError(error)}`);
    process.exitCode = 2;
  }
}
