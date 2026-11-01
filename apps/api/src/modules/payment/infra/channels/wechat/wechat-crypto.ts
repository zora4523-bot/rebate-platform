// B2-15k: WeChat Pay API v3 primitives, ported from task/PAY-01 packages/pay-channels (transfer
// fields not ported: payouts belong to the payout line). Documents, not yet run against a merchant
// account (BR-PAY-09): request signature docs-mirror/wechat-pay/pages/4012365342.txt (five lines,
// each ending in \n), response and notification signature 4013053249.txt (three lines, each ending
// in \n; `WECHATPAY/SIGNTEST/` marks probe traffic, lines 74-79), APP launch signature 4012365340.txt
// (appId, timestamp, nonce, prepay id), AES-256-GCM 4012071382.txt.
// Also compiled by the `test` project: erasable syntax only.
import { createDecipheriv, createSign, createVerify } from 'node:crypto';

const SCHEMA = 'WECHATPAY2-SHA256-RSA2048';
const TAG_BYTES = 16;

function rsaSha256(message: string, privateKeyPem: string): string {
  return createSign('RSA-SHA256').update(message, 'utf8').sign(privateKeyPem, 'base64');
}

export interface WechatAuthorizationInput {
  readonly mchId: string;
  readonly merchantSerial: string;
  readonly privateKeyPem: string;
  readonly method: 'GET' | 'POST';
  /** Path with its query string, exactly as sent. */
  readonly pathWithQuery: string;
  /** The exact request body; empty for GET. */
  readonly body: string;
  readonly timestamp: string;
  readonly nonce: string;
}

/** The value of the Authorization request header. */
export function wechatAuthorization(input: WechatAuthorizationInput): string {
  const signature = rsaSha256(
    `${input.method}\n${input.pathWithQuery}\n${input.timestamp}\n${input.nonce}\n${input.body}\n`,
    input.privateKeyPem,
  );
  return (
    `${SCHEMA} mchid="${input.mchId}",nonce_str="${input.nonce}",signature="${signature}",` +
    `timestamp="${input.timestamp}",serial_no="${input.merchantSerial}"`
  );
}

/** The `sign` of the APP launch parameters. */
export function wechatLaunchSign(
  appId: string,
  timestamp: string,
  nonce: string,
  prepayId: string,
  privateKeyPem: string,
): string {
  return rsaSha256(`${appId}\n${timestamp}\n${nonce}\n${prepayId}\n`, privateKeyPem);
}

/** A response or notification signature over the body as received. Probe signatures never pass. */
export function verifyWechatSignature(
  publicKeyPem: string,
  timestamp: string,
  nonce: string,
  body: string,
  signature: string,
): boolean {
  if (signature.startsWith('WECHATPAY/SIGNTEST/')) return false;
  try {
    return createVerify('RSA-SHA256')
      .update(`${timestamp}\n${nonce}\n${body}\n`, 'utf8')
      .verify(publicKeyPem, signature, 'base64');
  } catch {
    return false;
  }
}

/** AEAD_AES_256_GCM with the APIv3 key: ciphertext = base64(data + 16-byte tag). Throws on any fault. */
export function decryptWechatResource(
  apiV3Key: string,
  ciphertext: string,
  nonce: string,
  associatedData: string,
): string {
  const key = Buffer.from(apiV3Key, 'utf8');
  const sealed = Buffer.from(ciphertext, 'base64');
  if (sealed.length < TAG_BYTES) throw new Error('ciphertext too short');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'utf8'));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  decipher.setAAD(Buffer.from(associatedData, 'utf8'));
  return Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
    decipher.final(),
  ]).toString('utf8');
}
