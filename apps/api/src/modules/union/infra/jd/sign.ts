// 京东联盟网关 md5 签名与公共参数时间戳（B1-04za）。规则测试：test/spec/union/jd-core/sign.test.ts。
// 签名：除 sign 外全部参数 → 参数名按字节升序（360buy_param_json 排在 app_key 前）→ 依次拼接
// 「名 + 值」→ 头尾各加 app_secret → MD5 → 大写十六进制。值原样（UTF-8，不做 URL 编码）。
// timestamp：与淘宝同一格式（GMT+8 的 yyyy-MM-dd HH:mm:ss，毫秒舍去，与进程时区无关）。
// app_secret 只在内存里参与计算，不进日志、错误或返回值以外的任何地方。
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { taobaoTimestamp } from '../taobao/sign.ts';

/** Parameter name → the exact text that is signed and submitted as the form value. */
export type JdParameters = Readonly<Record<string, string>>;

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** MD5(secret + name-byte-sorted name + value pairs without `sign` + secret), uppercase hex. */
export function signJdParameters(parameters: JdParameters, appSecret: string): string {
  const names = Object.keys(parameters)
    .filter((name) => name !== 'sign')
    .sort(compareBytes);
  let text = appSecret;
  for (const name of names) text += name + parameters[name]!;
  text += appSecret;
  return createHash('md5').update(text, 'utf8').digest('hex').toUpperCase();
}

/** `yyyy-MM-dd HH:mm:ss` at GMT+8, independent of the process time zone. */
export function jdTimestamp(instant: Date): string {
  return taobaoTimestamp(instant);
}
