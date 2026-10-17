import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { describeError, redactCredentials } from '../../../../packages/db/src/pg-url.ts';

// 32–38 KB 的合成输入；绝对耗时断言与 Vitest 超时分开，旧实现应因断言失败而红。
// 三次取最小值只用于减少调度抖动，每次调用的输出都必须满足固定语义。
function checkLinear(input: string, warmup: string, expected: string): void {
  const entries = [
    { name: 'redactCredentials', run: redactCredentials, expected },
    {
      name: 'describeError',
      run: (text: string): string => describeError(new Error(text)),
      expected: `Error: ${expected}`,
    },
  ];
  const measurements: { name: string; bestMs: number }[] = [];
  for (const entry of entries) {
    entry.run(warmup);
    let bestMs = Number.POSITIVE_INFINITY;
    for (let sample = 0; sample < 3; sample++) {
      const start = performance.now();
      const output = entry.run(input);
      const elapsedMs = performance.now() - start;
      bestMs = Math.min(bestMs, elapsedMs);
      // 断言与夹具构造均不计入单次打码耗时。
      expect(output, `${entry.name} 保持打码语义`).toBe(entry.expected);
    }
    measurements.push({ name: entry.name, bestMs });
  }
  // 两个入口都完成测量后再断言，避免第一个入口超限掩盖第二个入口。
  for (const { name, bestMs } of measurements) {
    expect(bestMs, `${name} 三次最小耗时不得超过 250 毫秒`).toBeLessThanOrEqual(250);
  }
}

it('[AC-B1-01zzd#1] 普通长单词原样保留且两个入口均在时限内完成', { timeout: 120_000 }, () => {
  const input = 'a'.repeat(32_000);
  // 没有 URL 凭据或口令赋值，不应改写任何字符。
  checkLinear(input, 'aaa', 'a'.repeat(32_000));
});

it(
  '[AC-B1-01zzd#2] 没有艾特符的长 URL 原样保留且两个入口均在时限内完成',
  { timeout: 120_000 },
  () => {
    const input = 'x://' + 'b'.repeat(32_000);
    checkLinear(input, 'x://bbb', 'x://' + 'b'.repeat(32_000));
  },
);

it(
  '[AC-B1-01zzd#3] 闭合引号后粘连长文本全部打码且两个入口均在时限内完成',
  { timeout: 120_000 },
  () => {
    const input = "password='x' " + 'q'.repeat(32_000) + "'";
    // 引号闭合后的空白不跟确知参数名与等号，仍属于口令，一直打码到末尾。
    checkLinear(input, "password='x' q'", 'password=***');
  },
);

it(
  '[AC-B1-01zzd#4] 逗号粘连的重复未加引号口令全部打码且两个入口均在时限内完成',
  { timeout: 120_000 },
  () => {
    const input = 'password=a,'.repeat(3_200);
    // keyword/value 形式的逗号不是边界；全部重叠口令区间合并为一个掩码。
    checkLinear(input, 'password=a,password=a,', 'password=***');
  },
);

it(
  '[AC-B1-01zzd#5] 重复未闭合引号口令全部打码且两个入口均在时限内完成',
  { timeout: 120_000 },
  () => {
    const input = "password='a ".repeat(3_200);
    // 每个赋值都须受保护，包括落在已有口令区间内、引号未闭合的最后一个。
    checkLinear(input, "password='a password='a ", 'password=***');
  },
);
