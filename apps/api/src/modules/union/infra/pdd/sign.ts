// 拼多多开放平台签名（4_PDD_附 §3.3）：全部参数（不含 sign）按参数名 ASCII 升序，
// 「参数名参数值」无分隔拼接，头尾各加一次 client_secret，取 MD5 转大写。
// client_secret 只在内存里参与计算，不进日志、错误或返回值以外的任何地方。
import { createHash } from 'node:crypto';

/** Values absent from a request are omitted by the caller, not signed as null/undefined. */
export type PddParameter =
  string | number | boolean | readonly unknown[] | Readonly<Record<string, unknown>>;
export type PddParameters = Readonly<Record<string, PddParameter>>;

/**
 * The text a parameter value contributes to the signature. Strings are used verbatim (UTF-8,
 * no URL encoding); numbers and booleans use their JavaScript string form; arrays and objects
 * use compact JSON, which is also the exact string submitted on the wire.
 */
// 数组参数：probe 核对通过（goods.search 的 range_list 作紧凑 JSON 字符串参与签名，网关接受；B1-04u）。
export function pddParameterText(value: PddParameter): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** ASCII key order, excluding sign; structured values use compact JSON strings. */
export function signPddParameters(parameters: PddParameters, clientSecret: string): string {
  const names = Object.keys(parameters)
    .filter((name) => name !== 'sign')
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let text = clientSecret;
  for (const name of names) text += name + pddParameterText(parameters[name]!);
  text += clientSecret;
  return createHash('md5').update(text, 'utf8').digest('hex').toUpperCase();
}
