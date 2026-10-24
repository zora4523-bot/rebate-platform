// B1-12w · ACS3-HMAC-SHA256 (Aliyun OpenAPI V3 signature), shared by every Aliyun caller (agent's
// content safety review, notification's SendSms channel; orchestrator ruling D10-315).
// https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature
//   CanonicalRequest = Method \n CanonicalURI \n CanonicalQueryString \n CanonicalHeaders \n
//                      SignedHeaders \n HashedRequestPayload
//   StringToSign     = "ACS3-HMAC-SHA256" \n Hex(SHA256(CanonicalRequest))
//   Signature        = Hex(HMAC-SHA256(AccessKeySecret, StringToSign))
// The query string comes from the endpoint (RFC 3986 encoded, sorted). Signed headers: host,
// content-type and every x-acs-* header (lowercase names, trimmed values, sorted). The signer only
// returns headers: it never changes the endpoint, the method or the body, and nothing here is
// logged (the secret leaves only as the HMAC key). Clock and nonce are injected.
import { createHash, createHmac } from 'node:crypto';
import type { Clock } from '../clock/index.ts';

export interface AliyunCredentials {
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
  readonly securityToken?: string;
}

export interface AliyunSignRequest {
  /** Full https URL; its query string is the request's query parameters. */
  readonly endpoint: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly action: string;
  readonly version: string;
}

export type AliyunAcs3Sign = (
  request: AliyunSignRequest,
  credentials: AliyunCredentials,
  signal: AbortSignal,
) => Promise<Readonly<Record<string, string>>>;

export interface AliyunAcs3SignerDeps {
  readonly clock: Clock;
  readonly nonce: () => string;
}

const ALGORITHM = 'ACS3-HMAC-SHA256';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** RFC 3986 percent-encoding, as the V3 document requires for the query string. */
function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalQuery(url: URL): string {
  const pairs = [...url.searchParams.entries()].map(
    ([key, value]) => [percentEncode(key), percentEncode(value)] as const,
  );
  pairs.sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  return pairs.map(([key, value]) => `${key}=${value}`).join('&');
}

function isSignedHeader(name: string): boolean {
  return name === 'host' || name === 'content-type' || name.startsWith('x-acs-');
}

/** ISO 8601 UTC without milliseconds (yyyy-MM-ddTHH:mm:ssZ). */
function acsDate(clock: Clock): string {
  return clock
    .now()
    .toISOString()
    .replace(/\.\d{3}Z$/u, 'Z');
}

/** ACS3 V3: clock and nonce are injected; returns headers only, never mutates the request. */
export function createAliyunAcs3Signer(deps: AliyunAcs3SignerDeps): AliyunAcs3Sign {
  return async (
    request: AliyunSignRequest,
    credentials: AliyunCredentials,
    signal: AbortSignal,
  ): Promise<Readonly<Record<string, string>>> => {
    if (signal.aborted) throw new Error('aliyun sign: aborted');
    const url = new URL(request.endpoint);
    const payloadHash = sha256Hex(request.body);

    // Headers produced here win over same-named request headers.
    const own: Record<string, string> = {
      host: url.host,
      'x-acs-action': request.action,
      'x-acs-version': request.version,
      'x-acs-date': acsDate(deps.clock),
      'x-acs-signature-nonce': deps.nonce(),
      'x-acs-content-sha256': payloadHash,
    };
    const token = credentials.securityToken;
    if (token !== undefined && token !== '') own['x-acs-security-token'] = token;

    const signed = new Map<string, string>();
    for (const [name, value] of Object.entries(request.headers)) {
      const lower = name.toLowerCase();
      if (isSignedHeader(lower)) signed.set(lower, value.trim());
    }
    for (const [name, value] of Object.entries(own)) signed.set(name, value.trim());

    const names = [...signed.keys()].sort();
    const signedHeaders = names.join(';');
    const canonicalHeaders = names.map((name) => `${name}:${signed.get(name) ?? ''}\n`).join('');
    const canonicalRequest = [
      request.method,
      url.pathname === '' ? '/' : url.pathname,
      canonicalQuery(url),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');
    const stringToSign = `${ALGORITHM}\n${sha256Hex(canonicalRequest)}`;
    const signature = createHmac('sha256', credentials.accessKeySecret)
      .update(stringToSign, 'utf8')
      .digest('hex');

    return {
      ...own,
      authorization: `${ALGORITHM} Credential=${credentials.accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`,
    };
  };
}
