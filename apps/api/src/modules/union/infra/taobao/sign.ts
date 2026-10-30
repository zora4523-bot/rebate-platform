// 淘宝开放平台（TOP）md5 签名与公共参数时间戳（B1-04j）。
// 签名：去掉值为 undefined / null / 空串的参数 → 参数名 ASCII 升序 → 依次拼接「名 + 值」→
// 头尾各加 app_secret → MD5 → 大写十六进制；sign 本身不参与。数字 / 布尔按字符串形式；
// 数组 / 对象按 JSON.stringify 参与签名，且原样作表单值。
// TODO(规划/11 §4.5): 数组 / 对象参数的签名与表单形式待录制核对 — blocked on 淘宝录制
// timestamp：注入 Clock 的时刻按北京时间（UTC+8）格式化为 yyyy-MM-dd HH:mm:ss，毫秒舍去。
// app_secret 只在内存里参与计算，不进日志、错误或返回值以外的任何地方。
import { createHash } from 'node:crypto';

/** undefined / null / '' are dropped from the signature and the form, never signed as text. */
export type TaobaoParameter =
  | string
  | number
  | boolean
  | readonly unknown[]
  | Readonly<Record<string, unknown>>
  | null
  | undefined;
export type TaobaoParameters = Readonly<Record<string, TaobaoParameter>>;

/**
 * The text a parameter contributes to the signature and submits as its form value, or undefined
 * when the parameter is empty (undefined / null / ''). Strings verbatim (UTF-8, no URL encoding);
 * numbers and booleans in their JavaScript string form; arrays and objects as compact JSON.
 */
export function taobaoParameterText(value: TaobaoParameter): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Non-empty parameters except `sign` as [name, text] pairs in ASCII name order. */
export function taobaoSignedEntries(parameters: TaobaoParameters): [string, string][] {
  const entries: [string, string][] = [];
  for (const name of Object.keys(parameters)) {
    if (name === 'sign') continue;
    const text = taobaoParameterText(parameters[name]);
    if (text !== undefined) entries.push([name, text]);
  }
  return entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** TOP md5 signature of every non-empty parameter except `sign`, uppercase hex. */
export function signTaobaoParameters(parameters: TaobaoParameters, appSecret: string): string {
  let text = appSecret;
  for (const [name, value] of taobaoSignedEntries(parameters)) text += name + value;
  text += appSecret;
  return createHash('md5').update(text, 'utf8').digest('hex').toUpperCase();
}

const BEIJING_OFFSET_SECONDS = 8 * 3600;
const SECONDS_PER_DAY = 86_400;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** Proleptic Gregorian civil date of a day count since 1970-01-01 (H. Hinnant's days_from_civil inverse). */
function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return { year, month, day };
}

/**
 * `yyyy-MM-dd HH:mm:ss` in Beijing time (UTC+8), independent of the process time zone: plain
 * arithmetic on the epoch seconds of the injected instant (milliseconds dropped), no Date parsing.
 */
export function taobaoTimestamp(instant: Date): string {
  const local = Math.floor(instant.getTime() / 1000) + BEIJING_OFFSET_SECONDS;
  const days = Math.floor(local / SECONDS_PER_DAY);
  const secondOfDay = local - days * SECONDS_PER_DAY;
  const { year, month, day } = civilFromDays(days);
  const hour = Math.floor(secondOfDay / 3600);
  const minute = Math.floor((secondOfDay % 3600) / 60);
  const second = secondOfDay % 60;
  return `${pad(year, 4)}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
}
