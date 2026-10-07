// Small helpers shared by the scripts in this directory.

/** Command-line arguments without the `--` separator that pnpm passes through. */
export function cliArgs(): string[] {
  return process.argv.slice(2).filter((arg) => arg !== '--');
}

export function info(message: string): void {
  console.error(message);
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

// `scheme://user:password@` anywhere in a text: the password part is replaced.
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*):[^\s/?#@]*@/gi;

/** `text` with the password of every embedded `scheme://user:password@host` URL masked. */
export function redactCredentials(text: string): string {
  return text.replace(URL_CREDENTIALS, '$1:***@');
}

/**
 * A one-line description of a thrown value that is safe to print: the error name, its
 * `code` when it is a short identifier, and the message with URL passwords masked.
 * The raw object is never printed, because Node and driver errors carry the connection
 * string in fields such as `input` (ERR_INVALID_URL), `cause` and the stack.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return `非 Error 异常（${typeof error}）`;
  }
  const code = (error as { code?: unknown }).code;
  const tag =
    typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(code)
      ? `${error.name} [${code}]`
      : error.name;
  return `${tag}: ${redactCredentials(error.message)}`;
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
    // Never console.error(error): see describeError.
    console.error(`错误：${describeError(error)}`);
    process.exitCode = 2;
  }
}
