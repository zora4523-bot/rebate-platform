// 大淘客开放平台新验签（gz-41）与公共参数 timer / nonce（B1-04m，D10-486 ①）。
// signRan：文本「appKey=<appKey>&timer=<timer>&nonce=<nonce>&key=<appSecret>」按 UTF-8 做 MD5 →
// 大写十六进制；只这四项按这个顺序参与，原样拼接（不排序、不 URL 编码），业务参数与 version 不参与。
// timer：注入 Clock 时刻的毫秒时间戳十进制串（毫秒不舍去）。
// nonce：注入随机源给出的 [0, 1000000) 整数左补零到恰 6 位数字；越界、非整数或非有限值 → RangeError。
// appSecret 只在内存里参与计算，不进日志、错误或返回值以外的任何地方。
// TODO(规划/11 §4.5): 签名文本与公共参数待大淘客实测录制核对 — blocked on 大淘客录制
import { createHash } from 'node:crypto';

/** Exclusive upper bound of the random source value: six decimal digits. */
export const DATAOKE_NONCE_BOUND = 1_000_000;
const NONCE_DIGITS = 6;

/** The three public values that take part in signRan besides the secret. */
export interface DataokeSignInput {
  readonly appKey: string;
  readonly timer: string;
  readonly nonce: string;
}

/** Uppercase hex MD5 of `appKey=<appKey>&timer=<timer>&nonce=<nonce>&key=<appSecret>`. */
export function dataokeSignRan(input: DataokeSignInput, appSecret: string): string {
  const text = `appKey=${input.appKey}&timer=${input.timer}&nonce=${input.nonce}&key=${appSecret}`;
  return createHash('md5').update(text, 'utf8').digest('hex').toUpperCase();
}

/** The injected instant as a decimal millisecond epoch timestamp. */
export function dataokeTimer(instant: Date): string {
  return String(instant.getTime());
}

/**
 * The random source's integer in [0, 1000000) as exactly six digits, zero-padded on the left.
 * Anything else (out of range, fractional, NaN, infinite) throws a RangeError.
 */
export function dataokeNonce(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value >= DATAOKE_NONCE_BOUND) {
    // 不带原值：随机源的输出与请求无关，也不需要出现在日志里。
    throw new RangeError('dataoke nonce: random value is not an integer in [0, 1000000)');
  }
  return String(value).padStart(NONCE_DIGITS, '0');
}
