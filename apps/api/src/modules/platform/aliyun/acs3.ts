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

export function createAliyunAcs3Signer(deps: AliyunAcs3SignerDeps): AliyunAcs3Sign {
  void deps;
  throw new Error('NotImplemented: createAliyunAcs3Signer');
}
