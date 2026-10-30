// 淘宝开放平台（TOP）md5 签名与公共参数时间戳（B1-04j，骨架；实现见实现轮）。
// 签名：去掉值为 undefined / null / 空串的参数 → 参数名 ASCII 升序 → 依次拼接「名 + 值」→
// 头尾各加 app_secret → MD5 → 大写十六进制；sign 本身不参与。数字 / 布尔按字符串形式；
// 数组 / 对象按 JSON.stringify 参与签名，且原样作表单值。
// TODO(规划/11 §4.5): 数组 / 对象参数的签名与表单形式待录制核对 — blocked on 淘宝录制
// timestamp：注入 Clock 的时刻按北京时间（UTC+8）格式化为 yyyy-MM-dd HH:mm:ss，毫秒舍去。

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

/** TOP md5 signature of every non-empty parameter except `sign`, uppercase hex. */
export function signTaobaoParameters(parameters: TaobaoParameters, appSecret: string): string {
  void parameters;
  void appSecret;
  throw new Error('NotImplemented: signTaobaoParameters');
}

/** `yyyy-MM-dd HH:mm:ss` in Beijing time (UTC+8), independent of the process time zone. */
export function taobaoTimestamp(instant: Date): string {
  void instant;
  throw new Error('NotImplemented: taobaoTimestamp');
}
