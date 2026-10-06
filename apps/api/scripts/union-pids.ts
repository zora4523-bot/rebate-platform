// B1-19c：推广位 CLI；业务写入、super + TOTP 验证、事务审计均委托 B1-19b 服务。
// 脚本只做命令行外壳：参数解析、交互读入动态码（不回显、不进命令历史与日志）、调用服务、打印安全字段。
//
// 运行方式（仓库根目录；服务带 Nest 装饰器，node 不能直接加载源码，须先构建再从 apps/api/dist 加载）：
//   pnpm build
//   APP_ENV=<环境> DATABASE_URL=<couli_app 连接> FIELD_*=<字段加密密钥配置> \
//     node apps/api/scripts/union-pids.ts <命令> --app <app_id> [参数]
// 环境变量同 admin 入口与 admin-bootstrap.ts（字段加密密钥用于解密 super 的身份验证器密钥）。
// 入口分支从 ../dist/modules/** 编译产物组装依赖；导入本文件不启动入口（规则测试注入 deps 调 run）。
//
// register-account: --admin <UUID> --platform <平台> --account-name <名称>
//                   --auth-status <active|expiring|expired> [--auth-expires-at <带时区时间>]
// register-pid: --admin <UUID> --platform <平台> --union-account-id <UUID>
//               --pid <真实推广位> --pid-scene <场景> [--site-id <淘宝媒体位>]
// confirm-hjy: --admin <UUID> --pid-id <UUID> --evidence-path <截图路径>
//              [--confirmed-at <带时区时间>；省略时读注入 Clock]
// activate / retire: --admin <UUID> --pid-id <UUID>
// list-accounts / list-pids: [--platform <平台>]；只读，不要求动态码。
// 写命令支持 --idempotency-key <重试键>；省略时生成，调用服务前打印，失败时仍可取回。
// confirm-hjy 调用前也打印实际确认时间；重试时同时复用该时间（--confirmed-at）和重试键。
// 动态码仅从交互终端隐藏读取，不接受命令行传码；无删除命令。
// 退出码见 UNION_PIDS_EXIT：0 成功，1 其他失败，2 参数不合法，3 服务拒绝（含二次验证失败），4 无交互终端或取消输入。
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { ReadStream, WriteStream } from 'node:tty';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { Clock } from '../src/modules/platform/index.ts';
import type {
  PidPlatform,
  RegisterAccountInput,
  RegisterPidInput,
  UnionAccountRow,
  UnionPidRow,
  UnionPidService,
} from '../src/modules/union/index.ts';

export interface UnionPidListInput {
  readonly appId: string;
  readonly platform?: PidPlatform;
}

/** Read-only queries: never use active-only lookup to implement the operator's full list. */
export interface UnionPidQueries {
  listAccounts(input: UnionPidListInput): Promise<readonly UnionAccountRow[]>;
  listPids(input: UnionPidListInput): Promise<readonly UnionPidRow[]>;
}

export interface UnionPidCliDeps {
  readonly service: Pick<
    UnionPidService,
    'registerAccount' | 'registerPid' | 'confirmHjyIgnore' | 'setPidStatus'
  >;
  readonly queries: UnionPidQueries;
  readonly clock: Clock;
  readonly newIdempotencyKey: () => string;
  readonly terminal: {
    readonly isTTY: boolean;
    readonly readCode: () => Promise<string | null>;
    readonly write: (message: string) => void;
    readonly error: (message: string) => void;
  };
}

export const UNION_PIDS_EXIT = Object.freeze({
  ok: 0,
  failed: 1,
  invalid: 2,
  refused: 3,
  cancelled: 4,
});

type WriteCommand = 'register-account' | 'register-pid' | 'confirm-hjy' | 'activate' | 'retire';
type ListCommand = 'list-accounts' | 'list-pids';
type Command = WriteCommand | ListCommand;

type OptionName =
  | 'app'
  | 'admin'
  | 'platform'
  | 'account-name'
  | 'auth-status'
  | 'auth-expires-at'
  | 'union-account-id'
  | 'pid'
  | 'pid-scene'
  | 'site-id'
  | 'pid-id'
  | 'evidence-path'
  | 'confirmed-at'
  | 'idempotency-key';

/** Required and optional options per command; anything else (including any code flag) is refused. */
const COMMANDS: Readonly<
  Record<
    Command,
    { readonly required: readonly OptionName[]; readonly optional: readonly OptionName[] }
  >
> = {
  'register-account': {
    required: ['app', 'admin', 'platform', 'account-name', 'auth-status'],
    optional: ['auth-expires-at', 'idempotency-key'],
  },
  'register-pid': {
    required: ['app', 'admin', 'platform', 'union-account-id', 'pid', 'pid-scene'],
    optional: ['site-id', 'idempotency-key'],
  },
  'confirm-hjy': {
    required: ['app', 'admin', 'pid-id', 'evidence-path'],
    optional: ['confirmed-at', 'idempotency-key'],
  },
  activate: { required: ['app', 'admin', 'pid-id'], optional: ['idempotency-key'] },
  retire: { required: ['app', 'admin', 'pid-id'], optional: ['idempotency-key'] },
  'list-accounts': { required: ['app'], optional: ['platform'] },
  'list-pids': { required: ['app'], optional: ['platform'] },
};

const USAGE =
  '用法：union-pids.ts <register-account|register-pid|confirm-hjy|activate|retire|list-accounts|list-pids> --app <app_id> [参数]；参数说明见脚本头注释。';

/** Same shape the service accepts (B1-19b): letters, digits, underscore and hyphen. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/;
/** An instant with an explicit offset; a bare local time would depend on the operator's machine. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Known service refusals (B1-19b UnionPidErrorCode); their messages are fixed texts. */
const REFUSALS: Readonly<Record<string, string>> = {
  invalid_input: '参数不合法',
  not_verified: '二次验证未通过（需要启用中、已绑定身份验证器的 super 账号与当前动态码）',
  not_found: '记录不存在',
  illegal_transition: '状态不允许这样变更',
  evidence_missing: '尚未补填花卷云确认时间与截图路径',
  duplicate: '记录已存在',
  conflict: '记录已被并发修改，请重试',
  idempotency_conflict: '重试键已用于另一请求',
  idempotency_in_progress: '同一重试键的请求正在处理',
};

function isCommand(value: string | undefined): value is Command {
  return value !== undefined && Object.hasOwn(COMMANDS, value);
}

function isWriteCommand(command: Command): command is WriteCommand {
  return command !== 'list-accounts' && command !== 'list-pids';
}

function parseInstant(value: string): Date | null {
  if (!INSTANT.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

type Parsed = { readonly command: Command; readonly values: Partial<Record<OptionName, string>> };

/** Never echoes argument values: the error text is fixed. */
function parse(argv: readonly string[]): Parsed | string {
  const [command, ...rest] = argv;
  if (!isCommand(command)) return '未知命令（没有删除命令）。';
  const spec = COMMANDS[command];
  const options: Record<string, { type: 'string' }> = {};
  for (const name of [...spec.required, ...spec.optional]) options[name] = { type: 'string' };
  let values: Record<string, string | boolean | (string | boolean)[] | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...rest],
      options,
      strict: true,
      allowPositionals: true,
    }));
  } catch {
    // parseArgs messages may repeat the offending token (for example a code passed by flag).
    return '参数不合法：存在未知参数、缺少参数值或该命令不接受的参数。';
  }
  if (positionals.length > 0) return '参数不合法：不接受多余的位置参数。';
  const out: Partial<Record<OptionName, string>> = {};
  for (const name of [...spec.required, ...spec.optional]) {
    const value = values[name];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.trim().length === 0) return `参数 --${name} 不能为空。`;
    out[name] = value;
  }
  for (const name of spec.required) {
    if (out[name] === undefined) return `缺少参数 --${name}。`;
  }
  const key = out['idempotency-key'];
  if (key !== undefined && !IDEMPOTENCY_KEY.test(key)) {
    return '参数 --idempotency-key 只能由字母、数字、下划线和短横线组成，长度八到六十四。';
  }
  for (const name of ['auth-expires-at', 'confirmed-at'] as const) {
    const value = out[name];
    if (value !== undefined && parseInstant(value) === null) {
      return `参数 --${name} 须为带时区的 ISO 时间，例如 2031-05-06T15:08:09+08:00。`;
    }
  }
  return { command, values: out };
}

const ACCOUNT_FIELDS = [
  'id',
  'app_id',
  'platform',
  'account_name',
  'status',
  'auth_status',
  'auth_expires_at',
  'sync_start_at',
  'created_at',
  'updated_at',
] as const;

const PID_FIELDS = [
  'id',
  'app_id',
  'platform',
  'union_account_id',
  'site_id',
  'pid',
  'pid_scene',
  'status',
  'hjy_ignore_confirmed_at',
  'hjy_ignore_evidence_path',
  'created_at',
  'updated_at',
] as const;

/** Only whitelisted columns; probe diagnostics and any extra property never reach the terminal. */
function safeLine(row: object, fields: readonly string[]): string {
  const source = row as Record<string, unknown>;
  const out: Record<string, string | number | boolean | null> = {};
  for (const field of fields) {
    const value = source[field];
    if (value instanceof Date)
      out[field] = Number.isNaN(value.getTime()) ? null : value.toISOString();
    else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      out[field] = value;
    else if (typeof value === 'bigint') out[field] = value.toString();
    else out[field] = null;
  }
  return JSON.stringify(out);
}

/** A fixed text for the failure; raw messages of unknown errors may carry inputs or credentials. */
function describeFailure(error: unknown): { readonly exitCode: number; readonly message: string } {
  if (error instanceof Error && error.name === 'UnionPidError') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && Object.hasOwn(REFUSALS, code)) {
      const detail =
        code === 'invalid_input' || code === 'illegal_transition' ? `：${error.message}` : '';
      return {
        exitCode: UNION_PIDS_EXIT.refused,
        message: `服务拒绝（${code}）：${REFUSALS[code]}${detail}`,
      };
    }
  }
  return {
    exitCode: UNION_PIDS_EXIT.failed,
    message: '执行失败（原始错误不打印，请查看服务端日志或联系维护者）。',
  };
}

async function runList(
  command: ListCommand,
  values: Partial<Record<OptionName, string>>,
  deps: UnionPidCliDeps,
): Promise<{ readonly exitCode: number }> {
  const input: UnionPidListInput =
    values.platform === undefined
      ? { appId: values.app! }
      : { appId: values.app!, platform: values.platform as PidPlatform };
  let rows: readonly object[];
  try {
    rows =
      command === 'list-accounts'
        ? await deps.queries.listAccounts(input)
        : await deps.queries.listPids(input);
  } catch {
    deps.terminal.error('查询失败（原始错误不打印）。');
    return { exitCode: UNION_PIDS_EXIT.failed };
  }
  const fields = command === 'list-accounts' ? ACCOUNT_FIELDS : PID_FIELDS;
  deps.terminal.write(
    `app_id=${input.appId}${input.platform === undefined ? '' : ` platform=${input.platform}`}`,
  );
  if (rows.length === 0) deps.terminal.write('（无记录）');
  for (const row of rows) deps.terminal.write(safeLine(row, fields));
  return { exitCode: UNION_PIDS_EXIT.ok };
}

async function runWrite(
  command: WriteCommand,
  values: Partial<Record<OptionName, string>>,
  deps: UnionPidCliDeps,
): Promise<{ readonly exitCode: number }> {
  const { terminal } = deps;
  if (!terminal.isTTY) {
    terminal.error('写命令须在交互终端运行，以便隐藏输入动态码；不接受管道或参数传码。');
    return { exitCode: UNION_PIDS_EXIT.cancelled };
  }
  const idempotencyKey = values['idempotency-key'] ?? deps.newIdempotencyKey();
  terminal.write(`重试键：${idempotencyKey}（失败重试时带 --idempotency-key ${idempotencyKey}）`);
  let code: string | null;
  try {
    code = await terminal.readCode();
  } catch {
    code = null;
  }
  if (code === null || code.length === 0) {
    terminal.error('未输入动态码，已取消，未写入任何数据。');
    return { exitCode: UNION_PIDS_EXIT.cancelled };
  }
  const context = {
    appId: values.app!,
    adminId: values.admin!,
    code,
    ip: null,
    idempotencyKey,
  };
  try {
    let row: object;
    let fields: readonly string[] = PID_FIELDS;
    switch (command) {
      case 'register-account': {
        const expires = values['auth-expires-at'];
        row = await deps.service.registerAccount({
          ...context,
          platform: values.platform as PidPlatform,
          accountName: values['account-name']!,
          authStatus: values['auth-status'] as RegisterAccountInput['authStatus'],
          authExpiresAt: expires === undefined ? null : parseInstant(expires),
        });
        fields = ACCOUNT_FIELDS;
        break;
      }
      case 'register-pid':
        row = await deps.service.registerPid({
          ...context,
          platform: values.platform as PidPlatform,
          unionAccountId: values['union-account-id']!,
          siteId: values['site-id'] ?? null,
          pid: values.pid!,
          pidScene: values['pid-scene'] as RegisterPidInput['pidScene'],
        });
        break;
      case 'confirm-hjy': {
        // Read after the code prompt: the confirmation instant is when the operator commits.
        const given = values['confirmed-at'];
        const confirmedAt = given === undefined ? deps.clock.now() : parseInstant(given)!;
        terminal.write(
          `确认时间：${confirmedAt.toISOString()}（重试时同时带 --confirmed-at ${confirmedAt.toISOString()}）`,
        );
        row = await deps.service.confirmHjyIgnore({
          ...context,
          pidId: values['pid-id']!,
          evidencePath: values['evidence-path']!,
          confirmedAt,
        });
        break;
      }
      case 'activate':
      case 'retire':
        row = await deps.service.setPidStatus({
          ...context,
          pidId: values['pid-id']!,
          status: command === 'activate' ? 'active' : 'retired',
        });
        break;
    }
    terminal.write(`完成：${command}`);
    terminal.write(safeLine(row, fields));
    return { exitCode: UNION_PIDS_EXIT.ok };
  } catch (error: unknown) {
    const failure = describeFailure(error);
    terminal.error(failure.message);
    terminal.error(`如需重试同一变更，请带 --idempotency-key ${idempotencyKey}。`);
    return { exitCode: failure.exitCode };
  }
}

/** 0 means success; invalid input, cancellation and service failures return a positive exitCode. */
export async function run(
  argv: readonly string[],
  deps: UnionPidCliDeps,
): Promise<{ readonly exitCode: number }> {
  const parsed = parse(argv);
  if (typeof parsed === 'string') {
    deps.terminal.error(parsed);
    deps.terminal.error(USAGE);
    return { exitCode: UNION_PIDS_EXIT.invalid };
  }
  return isWriteCommand(parsed.command)
    ? runWrite(parsed.command, parsed.values, deps)
    : runList(parsed.command, parsed.values, deps);
}

/** Hidden TTY input. Restore raw mode and listeners on completion, EOF, cancellation or error. */
export async function readHiddenCode(
  input: ReadStream,
  output: WriteStream,
): Promise<string | null> {
  if (input.isTTY !== true || output.isTTY !== true) return null;
  // No digits in the prompt or anything else written here (rule tests check the output).
  output.write('请输入身份验证器上的当前动态码（输入不回显）：');
  const wasRaw = input.isRaw;
  return new Promise<string | null>((resolve) => {
    let value = '';
    let done = false;
    const finish = (result: string | null) => {
      if (done) return;
      done = true;
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      input.setRawMode(wasRaw);
      input.pause();
      value = '';
      output.write('\n');
      resolve(result);
    };
    const onEnd = () => finish(null);
    const onError = () => finish(null);
    const onData = (chunk: Buffer | string) => {
      for (const char of typeof chunk === 'string' ? chunk : chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') return finish(value);
        if (char === '\u0003' || char === '\u0004') return finish(null);
        if (char === '\u007f' || char === '\b') value = [...value].slice(0, -1).join('');
        else if (char >= ' ') value += char;
      }
    };
    input.setRawMode(true);
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onError);
    input.resume();
  });
}

// ---- Entry: only when executed directly; assembles the built services from apps/api/dist. ----

function distUrl(path: string): string {
  return new URL(`../dist/${path}`, import.meta.url).href;
}

async function main(): Promise<number> {
  // Nest decorators in the built platform barrel need the metadata polyfill before loading.
  await import('reflect-metadata');
  const [configMod, clockMod, keyringMod, dbMod, loggerMod, pidsMod, verifyMod, auditMod] =
    (await Promise.all([
      import(distUrl('modules/platform/config/config.js')),
      import(distUrl('modules/platform/clock/clock.js')),
      import(distUrl('modules/platform/config/keyring-startup.js')),
      import(distUrl('modules/platform/db/index.js')),
      import(distUrl('modules/platform/logging/logger.js')),
      import(distUrl('modules/union/pids/service.js')),
      import(distUrl('modules/admin/application/verify-super.js')),
      import(distUrl('modules/admin/infra/audit-writer.js')),
    ])) as [
      typeof import('../src/modules/platform/config/config.ts'),
      typeof import('../src/modules/platform/clock/clock.ts'),
      typeof import('../src/modules/platform/config/keyring-startup.ts'),
      typeof import('../src/modules/platform/db/index.ts'),
      typeof import('../src/modules/platform/logging/logger.ts'),
      typeof import('../src/modules/union/pids/service.ts'),
      typeof import('../src/modules/admin/application/verify-super.ts'),
      typeof import('../src/modules/admin/infra/audit-writer.ts'),
    ];
  const config = configMod.loadConfig(process.env);
  if (config.keyring === null) {
    process.stderr.write('未配置字段加密密钥（FIELD_*），无法解密身份验证器密钥。\n');
    return UNION_PIDS_EXIT.invalid;
  }
  const logger = loggerMod.createRootLogger(
    { level: config.logLevel, entry: 'union-pids', appEnv: config.appEnv },
    (await import('pino')).destination(2),
  );
  const crypto = await keyringMod.openConfiguredFieldCrypto(config.appEnv, config.keyring);
  const clock = clockMod.clockFromConfig(config);
  const url = dbMod.loadDatabaseUrl(process.env['DATABASE_URL'] ?? '', 'DATABASE_URL');
  const handles = dbMod.createManagedDbHandles(
    { name: 'db', url, max: 1, applicationName: 'couli-union-pids', readOnly: false },
    null,
    { logger },
  );
  const db = handles.db;
  try {
    const service = pidsMod.createUnionPidService({
      db,
      clock,
      // Same active-status value as admin-bootstrap's default (admin_users.status is open in 0016).
      superVerifier: verifyMod.createSuperVerifier({ db, clock, crypto, activeStatus: 'active' }),
      auditWriter: (trx) =>
        auditMod.createAuditWriter({ db: trx, clock, sensitiveKeys: loggerMod.SENSITIVE_KEYS }),
    });
    const queries: UnionPidQueries = {
      async listAccounts(input) {
        let query = db.selectFrom('union_accounts').selectAll().where('app_id', '=', input.appId);
        if (input.platform !== undefined) query = query.where('platform', '=', input.platform);
        return query.orderBy('created_at').orderBy('id').execute();
      },
      async listPids(input) {
        let query = db.selectFrom('union_pids').selectAll().where('app_id', '=', input.appId);
        if (input.platform !== undefined) query = query.where('platform', '=', input.platform);
        return query.orderBy('created_at').orderBy('id').execute();
      },
    };
    const { exitCode } = await run(process.argv.slice(2), {
      service,
      queries,
      clock,
      newIdempotencyKey: () => randomUUID(),
      terminal: {
        isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
        readCode: () => readHiddenCode(process.stdin, process.stdout),
        write: (message) => process.stdout.write(`${message}\n`),
        error: (message) => process.stderr.write(`${message}\n`),
      },
    });
    return exitCode;
  } finally {
    await handles.close();
  }
}

function executedDirectly(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (executedDirectly()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // Configuration, keyring and missing-build errors carry fixed texts without values.
      process.stderr.write(
        `启动失败：${error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error'}（未构建时先运行 pnpm build）\n`,
      );
      process.exitCode = UNION_PIDS_EXIT.failed;
    },
  );
}
