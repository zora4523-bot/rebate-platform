// 独立 oracle（B1-12w）：按阿里云「V3 版本请求体&签名机制」逐步复算 ACS3-HMAC-SHA256。
// https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature
//   CanonicalRequest = Method \n CanonicalURI \n CanonicalQueryString \n CanonicalHeaders \n
//                      SignedHeaders \n HashedRequestPayload
//   StringToSign     = "ACS3-HMAC-SHA256" \n Hex(SHA256(CanonicalRequest))
//   Signature        = Hex(HMAC-SHA256(AccessKeySecret, StringToSign))
// 只用 node:crypto，不从被测代码取任何规范化、编码或哈希函数。
import { createHash, createHmac } from 'node:crypto';

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** RFC 3986：除 A-Z a-z 0-9 - _ . ~ 外一律 %XX（大写），空格是 %20。 */
export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export interface Acs3OracleInput {
  readonly method: string;
  readonly host: string;
  readonly path: string;
  /** 解码后的查询参数（顺序不限）。 */
  readonly query: readonly (readonly [string, string])[];
  /** host 以外参与签名的请求头（content-type 与 x-acs-*），名字大小写不限。 */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly accessKeyId: string;
  /** HMAC 用的 AccessKeySecret。 */
  readonly hmacKey: string;
}

export interface Acs3OracleResult {
  readonly hashedRequest: string;
  readonly signedHeaders: string;
  readonly signature: string;
  readonly authorization: string;
}

export function acs3Oracle(input: Acs3OracleInput): Acs3OracleResult {
  const all = new Map<string, string>([['host', input.host]]);
  for (const [name, value] of Object.entries(input.headers)) {
    all.set(name.toLowerCase(), value.trim());
  }
  const names = [...all.keys()].sort();
  const canonicalHeaders = names.map((name) => `${name}:${all.get(name) ?? ''}\n`).join('');
  const query = input.query
    .map(([name, value]) => [rfc3986(name), rfc3986(value)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  const canonical = [
    input.method,
    input.path,
    query,
    canonicalHeaders,
    names.join(';'),
    sha256(input.body),
  ].join('\n');
  const hashedRequest = sha256(canonical);
  const signature = createHmac('sha256', input.hmacKey)
    .update(`ACS3-HMAC-SHA256\n${hashedRequest}`, 'utf8')
    .digest('hex');
  const signedHeaders = names.join(';');
  return {
    hashedRequest,
    signedHeaders,
    signature,
    authorization: `ACS3-HMAC-SHA256 Credential=${input.accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`,
  };
}

/** 请求头名字转小写。 */
export function lowerHeaders(
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

/** 实际发出的请求头里参与签名的那些（content-type 与 x-acs-*；host 由 oracle 取自 URL）。 */
export function signedRequestHeaders(
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(lowerHeaders(headers)).filter(
      ([name]) => name === 'content-type' || name.startsWith('x-acs-'),
    ),
  );
}
