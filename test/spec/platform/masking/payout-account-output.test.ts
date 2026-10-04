// Rule tests (review round 1 addendum) for 规划/08 BR-ID-33 日志中不得出现明文 applied to the payout
// account masking: the functions of apps/api/src/modules/platform/masking/payout-account.ts write
// nothing anywhere while they mask (no log line, no stdout / stderr, no console, no fs write), and
// the source imports only './index.ts' (contract in that file's header, "No output of any kind").
// Top-level it() only (规划/11 §4.3).
import { readFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import {
  maskAlipayLogonId,
  maskBankCardTail,
  maskPayeeName,
} from '../../../../apps/api/src/modules/platform/masking/payout-account.ts';

type Mask = (text: string) => string;

/** The result of `mask(text)`, or `threw <name>: <message>` when it throws. */
function run(mask: Mask, text: string): string {
  try {
    const out: unknown = mask(text);
    return typeof out === 'string' ? out : `returned ${typeof out}`;
  } catch (error) {
    return error instanceof Error
      ? `threw ${error.name}: ${error.message}`
      : `threw ${String(error)}`;
  }
}

const nodeRequire = createRequire(import.meta.url);
const fsModule = nodeRequire('node:fs') as Record<string, unknown>;

const DEFERRAL_ROUNDS = 3;

const FS_WRITERS = [
  'write',
  'writeSync',
  'writev',
  'writevSync',
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'createWriteStream',
] as const;

/**
 * Runs `body` while every output channel is replaced by a recorder that writes nothing: each
 * console method, process.stdout.write, process.stderr.write, process.emitWarning and the write
 * functions of node:fs (CommonJS object and, after syncBuiltinESMExports, the ESM named exports;
 * pino's default destination writes to fd 1 through them). The hooks stay in place after `body`
 * returns until the microtask queue has drained and DEFERRAL_ROUNDS rounds of setImmediate and
 * setTimeout(0) have run, so a write deferred with queueMicrotask, a promise, setImmediate or
 * setTimeout(…, 0) is still recorded (longer delays are excluded by the static source check).
 * Returns the channels that were called.
 */
async function recordOutput(body: () => void): Promise<string[]> {
  const calls: string[] = [];
  const restores: (() => void)[] = [];
  const consoleRecord = console as unknown as Record<string, unknown>;
  for (const key of Object.keys(consoleRecord)) {
    if (typeof consoleRecord[key] !== 'function') continue;
    const spy = vi
      .spyOn(consoleRecord as Record<string, () => void>, key)
      .mockImplementation(() => {
        calls.push(`console.${key}`);
      });
    restores.push(() => spy.mockRestore());
  }
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => {
    calls.push('process.stdout.write');
    return true;
  });
  restores.push(() => stdoutSpy.mockRestore());
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => {
    calls.push('process.stderr.write');
    return true;
  });
  restores.push(() => stderrSpy.mockRestore());
  const warningSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {
    calls.push('process.emitWarning');
  });
  restores.push(() => warningSpy.mockRestore());
  for (const name of FS_WRITERS) {
    const original = fsModule[name];
    fsModule[name] = (): undefined => {
      calls.push(`fs.${name}`);
      return undefined;
    };
    restores.push(() => {
      fsModule[name] = original;
    });
  }
  syncBuiltinESMExports();
  try {
    body();
    for (let round = 0; round < DEFERRAL_ROUNDS; round += 1) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  } finally {
    for (const restore of restores.reverse()) restore();
    syncBuiltinESMExports();
  }
  return calls;
}

it('[BR-ID-33 日志中不得出现明文] 三个函数对合法与不合规输入脱敏时不写任何输出：console 各方法、stdout、stderr、emitWarning、node:fs 写入一次都没有（调用后再等微任务与 3 轮 setImmediate / setTimeout 0），结果照常', async () => {
  const calls: [Mask, string][] = [
    [maskAlipayLogonId, '13812345678'],
    [maskAlipayLogonId, 'zhangsan@example.com'],
    [maskAlipayLogonId, 'ab@x.com'],
    [maskAlipayLogonId, 'a@x.com'],
    [maskAlipayLogonId, 'a@b@x.com'],
    [maskAlipayLogonId, '+8613812345678'],
    [maskAlipayLogonId, ' zh@x.com'],
    [maskAlipayLogonId, ''],
    [maskBankCardTail, '6225880212341234'],
    [maskBankCardTail, '622202123456'],
    [maskBankCardTail, '6222 0212 3456 7890'],
    [maskBankCardTail, '62220212345678901234'],
    [maskPayeeName, '张小三'],
    [maskPayeeName, '王'],
    [maskPayeeName, '\u{20BB7}小三'],
    [maskPayeeName, '\uD800'],
  ];
  const results: string[] = [];
  const written = await recordOutput(() => {
    for (const [mask, text] of calls) results.push(run(mask, text));
  });
  expect({ written, results }).toEqual({
    written: [],
    results: [
      '138****5678',
      'zh***@example.com',
      'a***@x.com',
      '***@x.com',
      '*********',
      '**************',
      '*********',
      '',
      '尾号 1234',
      '尾号 3456',
      '*******************',
      '********************',
      '**三',
      '*',
      '**三',
      '*',
    ],
  });
});

it('[BR-ID-33 日志中不得出现明文] 输出记录器自检：console、stdout、stderr、emitWarning 与 node:fs（CommonJS 与 ESM 具名导出）的写入，以及 queueMicrotask、setImmediate、setTimeout 0 延后的写入都被记下、不真正写出', async () => {
  const esm = await import('node:fs');
  // Reached through globalThis, as code that hides a console call would (lint forbids `console.`).
  const consoleAlias = globalThis.console;
  const written = await recordOutput(() => {
    queueMicrotask(() => {
      consoleAlias.info('x');
    });
    setImmediate(() => {
      consoleAlias.trace('x');
    });
    setTimeout(() => {
      consoleAlias.warn('x');
    }, 0);
    consoleAlias.log('x');
    consoleAlias.error('x');
    process.stdout.write('');
    process.stderr.write('');
    process.emitWarning('x');
    (fsModule.writeSync as (fd: number, text: string) => void)(1, '');
    esm.writeSync(2, '');
    esm.appendFileSync('never-written.txt', 'x');
  });
  expect(written).toEqual([
    'console.log',
    'console.error',
    'process.stdout.write',
    'process.stderr.write',
    'process.emitWarning',
    'fs.writeSync',
    'fs.writeSync',
    'fs.appendFileSync',
    'console.info',
    'console.trace',
    'console.warn',
  ]);
});

/** Source text without comments (block comments, then line comments that start a line). */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

const MASKING_DIR = fileURLToPath(
  new URL('../../../../apps/api/src/modules/platform/masking/', import.meta.url),
);

function importsOf(code: string): string[] {
  return [...code.matchAll(/\b(?:from|import)\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');
}

// Words that must not occur in either source outside comments: output channels, ways to reach
// them indirectly (global objects, code evaluation) and ways to defer work past the call.
const FORBIDDEN_WORDS = [
  'console',
  'process',
  'global',
  'self',
  'window',
  'Reflect',
  'eval',
  'Function',
  'queueMicrotask',
  'setTimeout',
  'setImmediate',
  'setInterval',
  'Promise',
  'async',
  'await',
  'pino',
  'logging',
  'require',
];

function sourceFacts(code: string): {
  imports: string[];
  dynamicImport: boolean;
  words: string[];
} {
  return {
    imports: importsOf(code),
    dynamicImport: /\bimport\s*\(/.test(code),
    words: FORBIDDEN_WORDS.filter((word) => code.includes(word)),
  };
}

it('[BR-ID-33 日志中不得出现明文] 源码静态检查（payout-account.ts 与 index.ts 同一规则）：去掉注释后，payout-account.ts 只导入 ./index.ts、index.ts 不导入任何东西，都没有动态 import，都不出现 console、process、global、queueMicrotask、setTimeout、setImmediate、Promise、pino、logging 等禁用词', () => {
  expect({
    payoutAccount: sourceFacts(codeOf(`${MASKING_DIR}payout-account.ts`)),
    index: sourceFacts(codeOf(`${MASKING_DIR}index.ts`)),
  }).toEqual({
    payoutAccount: {
      imports: importsOf(codeOf(`${MASKING_DIR}payout-account.ts`)).filter(
        (specifier) => specifier === './index.ts',
      ),
      dynamicImport: false,
      words: [],
    },
    index: { imports: [], dynamicImport: false, words: [] },
  });
});
