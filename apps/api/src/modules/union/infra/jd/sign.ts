// 京东联盟网关 md5 签名与公共参数时间戳（B1-04za）。规则测试：test/spec/union/jd-core/sign.test.ts。
// 骨架：实现阶段补函数体。

/** Parameter name → the exact text that is signed and submitted as the form value. */
export type JdParameters = Readonly<Record<string, string>>;

/** MD5(secret + name-byte-sorted name + value pairs without `sign` + secret), uppercase hex. */
export function signJdParameters(parameters: JdParameters, appSecret: string): string {
  void parameters;
  void appSecret;
  throw new Error('NotImplemented: signJdParameters');
}

/** `yyyy-MM-dd HH:mm:ss` at GMT+8, independent of the process time zone. */
export function jdTimestamp(instant: Date): string {
  void instant;
  throw new Error('NotImplemented: jdTimestamp');
}
