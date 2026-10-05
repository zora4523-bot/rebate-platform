// 首个超级管理员引导命令（F1-06c；BR-ID-34「首次绑定身份验证器」）。只在 admin_users 里没有任何超管时可用；
// 有超管后一律拒绝（退出码非 0，不改任何数据）。由负责人本人在交互终端运行（规划/11 §7.1）。
//
// 运行（在 rebate-platform 根目录，环境变量同 admin 入口：APP_ENV、DATABASE_URL（couli_app 角色）、
// FIELD_KEY_PROVIDER / FIELD_MASTER_KEY_FILE / FIELD_KEYRING_FILE 等字段加密密钥配置）：
//
//   node --conditions=couli-src apps/api/scripts/admin-bootstrap.ts --app couli --login <登录名>
//
// 可选：--status <值>（启用状态，默认 active；admin_users.status 的取值契约未定，须与登录校验用的一致），
//       --issuer <名称>（身份验证器里显示的发行方，默认「Couli Admin」，非 prod 环境自动加环境名）。
// 流程：回显 app_id 与登录名并输入 yes 确认（不确认即退出、不写库）→ 输入两次密码（不回显）→ 终端显示一次 otpauth 绑定链接 → 用身份验证器 App 添加 → 输入当前 6 位动态码
// （不回显）→ 校验通过才在同一事务里建超管、写绑定、写审计。绑定信息只出现在终端，不写日志、不落文件；
// 结束时清屏。退出码见 BOOTSTRAP_EXIT（0 成功，3 已有超管，4 动态码未确认，5 登录名被占用，2 参数或输入不合法，
// 1 其他失败）。
//
// 只组装 @couli/db 与 admin/ 的纯模块，不 import Nest、不跑 dist。日志（pino）写到 stderr。
// 数据库连接与各进程入口相同：loadDatabaseUrl 解析出的离散字段与 TLS 选项（verify-full 按 URL 主机
// 校验证书，含 IP 主机）经 createManagedDbHandles 建单连接池，不把完整 URL 交给 pg 重新解析。
import { parseArgs } from 'node:util';
import { destination } from 'pino';
import {
  BOOTSTRAP_EXIT,
  MIN_PASSWORD_LENGTH,
  createAdminBootstrap,
  generateAdminTotpSecret,
  hashAdminPassword,
  type BootstrapTerminal,
} from '../src/modules/admin/application/bootstrap.ts';
import { createAuditWriter } from '../src/modules/admin/infra/audit-writer.ts';
import { clockFromConfig } from '../src/modules/platform/clock/clock.ts';
import { loadConfig } from '../src/modules/platform/config/config.ts';
import { openConfiguredFieldCrypto } from '../src/modules/platform/config/keyring-startup.ts';
import { createManagedDbHandles, loadDatabaseUrl } from '../src/modules/platform/db/index.ts';
import { newEventId as newUuidV7 } from '../src/modules/platform/events/events.ts';
import { SENSITIVE_KEYS, createRootLogger } from '../src/modules/platform/logging/logger.ts';

const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';

/** Reads one line from the TTY (no echo unless `echo`). null on Ctrl-C, Ctrl-D or end of input. */
function readLine(prompt: string, echo: boolean): Promise<string | null> {
  const input = process.stdin;
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let value = '';
    const finish = (result: string | null) => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
      resolve(result);
    };
    const onEnd = () => finish(null);
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') return finish(value);
        if (char === '\u0003' || char === '\u0004') return finish(null);
        if (char === '\u007f' || char === '\b') {
          if (echo && value !== '') process.stdout.write('\b \b');
          value = [...value].slice(0, -1).join('');
        } else if (char >= ' ') {
          if (echo) process.stdout.write(char);
          value += char;
        }
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
    input.once('end', onEnd);
  });
}

const readHidden = (prompt: string): Promise<string | null> => readLine(prompt, false);

function terminal(): BootstrapTerminal & { readonly bindingShown: () => boolean } {
  let shown = false;
  return {
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    readConfirmation: (question: string) => readLine(question, true),
    async readPassword() {
      for (let tries = 0; tries < 3; tries += 1) {
        const first = await readHidden(
          `设置超管密码（至少 ${String(MIN_PASSWORD_LENGTH)} 位，不回显）：`,
        );
        if (first === null) return null;
        const second = await readHidden('再输入一次：');
        if (second === null) return null;
        if (first === second) return first;
        process.stdout.write('两次输入不一致，请重新输入。\n');
      }
      return null;
    },
    readCode: () => readHidden('输入身份验证器上当前的 6 位动态码（不回显）：'),
    showBinding(uri: string) {
      shown = true;
      process.stdout.write(
        `\n请用身份验证器 App 添加下面的链接（只显示这一次，不要截图或转发）：\n\n${uri}\n\n`,
      );
    },
    write(message: string) {
      process.stdout.write(`${message}\n`);
    },
    bindingShown: () => shown,
  };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      app: { type: 'string' },
      login: { type: 'string' },
      status: { type: 'string', default: 'active' },
      issuer: { type: 'string', default: 'Couli Admin' },
    },
    strict: true,
  });
  if (values.app === undefined || values.login === undefined) {
    process.stderr.write('用法：admin-bootstrap.ts --app <app_id> --login <登录名>\n');
    return BOOTSTRAP_EXIT.invalid;
  }
  const config = loadConfig(process.env);
  if (config.keyring === null) {
    process.stderr.write('未配置字段加密密钥（FIELD_*），无法加密身份验证器密钥。\n');
    return BOOTSTRAP_EXIT.invalid;
  }
  const logger = createRootLogger(
    { level: config.logLevel, entry: 'admin-bootstrap', appEnv: config.appEnv },
    destination(2),
  );
  const crypto = await openConfiguredFieldCrypto(config.appEnv, config.keyring);
  const clock = clockFromConfig(config);
  const url = loadDatabaseUrl(process.env['DATABASE_URL'] ?? '', 'DATABASE_URL');
  const handles = createManagedDbHandles(
    { name: 'db', url, max: 1, applicationName: 'couli-admin-bootstrap', readOnly: false },
    null,
    { logger },
  );
  const db = handles.db;
  const tty = terminal();
  try {
    const bootstrap = createAdminBootstrap({
      db,
      clock,
      crypto,
      generateTotpSecret: generateAdminTotpSecret,
      newAdminId: () => newUuidV7(clock.now()),
      hashPassword: hashAdminPassword,
      audit: (transaction) =>
        createAuditWriter({ db: transaction, clock, sensitiveKeys: SENSITIVE_KEYS }),
      terminal: tty,
      logger: {
        info: (fields, message) => logger.info(fields, message),
        warn: (fields, message) => logger.warn(fields, message),
        error: (fields, message) => logger.error(fields, message),
      },
      activeStatus: values.status,
      issuer: config.appEnv === 'prod' ? values.issuer : `${values.issuer} ${config.appEnv}`,
    });
    const { exitCode } = await bootstrap.run({ appId: values.app, loginName: values.login });
    if (tty.bindingShown()) {
      await readHidden('按回车清屏并退出（绑定链接将从屏幕上清除）：');
      process.stdout.write(CLEAR_SCREEN);
    }
    return exitCode;
  } finally {
    await handles.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Configuration and keyring errors carry fixed texts without values.
    process.stderr.write(
      `引导失败：${error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error'}\n`,
    );
    process.exitCode = BOOTSTRAP_EXIT.failed;
  },
);
