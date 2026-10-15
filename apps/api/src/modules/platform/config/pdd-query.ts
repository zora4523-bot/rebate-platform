// 拼多多查询身份的 custom_parameters（B1-04x；B1-04u 裁定 D-u2）：服务端配置，不是密钥，
// 不登记进 ./credential-env.ts。纯函数：只看传入对象，问题文本只写变量名，不回显取值。
//
// - 未设或空字符串：null，任何环境都不拒绝启动（pdd live 而缺失时由 union 启动告警一次，
//   商品调用报 upstream_rejected）。
// - 设了值：必须是 JSON 对象文本，按 UTF-8 计不超过 PDD_QUERY_CUSTOM_PARAMETERS_MAX_BYTES 字节；
//   通过校验后原样保留文本（不重新序列化）。

export const PDD_QUERY_CUSTOM_PARAMETERS_ENV = 'PDD_QUERY_CUSTOM_PARAMETERS';

/** custom_parameters 的字节上限（与 union/infra/pdd/goods.ts 的商品接口校验一致）。 */
export const PDD_QUERY_CUSTOM_PARAMETERS_MAX_BYTES = 64;

function isJsonObjectText(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
}

export function readPddQueryConfig(env: Readonly<Record<string, string | undefined>>): {
  readonly pddQueryCustomParameters: string | null;
  readonly problems: readonly string[];
} {
  const value = env[PDD_QUERY_CUSTOM_PARAMETERS_ENV];
  if (value === undefined || value === '') return { pddQueryCustomParameters: null, problems: [] };
  const valid =
    Buffer.byteLength(value, 'utf8') <= PDD_QUERY_CUSTOM_PARAMETERS_MAX_BYTES &&
    isJsonObjectText(value);
  return valid
    ? { pddQueryCustomParameters: value, problems: [] }
    : { pddQueryCustomParameters: null, problems: [PDD_QUERY_CUSTOM_PARAMETERS_ENV] };
}
