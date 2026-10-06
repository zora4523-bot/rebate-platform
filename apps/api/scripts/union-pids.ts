// B1-19c：推广位 CLI；业务写入、super + TOTP 验证、事务审计均委托 B1-19b 服务。
// 实现后的运行方式（仓库根目录）：
//   pnpm build
//   node apps/api/scripts/union-pids.ts <命令> --app <app_id> [参数]
// 入口分支从 ../dist/modules/union/index.js 等编译产物组装依赖；导入本文件不启动入口。
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
// TODO(规划/11 §1.1): 实现 CLI 和仅在直接执行时运行的 dist 组装入口 — blocked on 规则测试先红核对
import type { ReadStream, WriteStream } from 'node:tty';
import type { Clock } from '../src/modules/platform/index.ts';
import type {
  PidPlatform,
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

/** 0 means success; invalid input, cancellation and service failures return a positive exitCode. */
export async function run(
  argv: readonly string[],
  deps: UnionPidCliDeps,
): Promise<{ readonly exitCode: number }> {
  void argv;
  void deps;
  throw new Error('NotImplemented: run');
}

/** Hidden TTY input. Restore raw mode and listeners on completion, EOF, cancellation or error. */
export async function readHiddenCode(
  input: ReadStream,
  output: WriteStream,
): Promise<string | null> {
  void input;
  void output;
  throw new Error('NotImplemented: readHiddenCode');
}
