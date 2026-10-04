// WeChat Pay API v3 primitives: request signing, response / notification verification,
// notification decryption, APP launch signature, sensitive-field encryption.
// Source: pay.weixin.qq.com merchant docs (mirrored privately, 2026-10-04). Not yet run against
// a live merchant account (规划/09 CAP-X-15, CAP-X-16).
import { constants, createDecipheriv, createSign, createVerify, publicEncrypt } from 'node:crypto';

const SCHEMA = 'WECHATPAY2-SHA256-RSA2048';

function rsaSha256Sign(message: string, privateKeyPem: string): string {
  return createSign('RSA-SHA256').update(message, 'utf8').sign(privateKeyPem, 'base64');
}

export interface AuthorizationInput {
  readonly mchid: string;
  readonly serialNo: string;
  readonly privateKeyPem: string;
  readonly method: 'GET' | 'POST';
  /** Path with query string, e.g. `/v3/pay/transactions/out-trade-no/X?mchid=1`. */
  readonly pathWithQuery: string;
  /** Exact request body; empty string for GET. */
  readonly body: string;
  /** Unix seconds. */
  readonly timestamp: number;
  readonly nonce: string;
}

/** Value of the `Authorization` request header. */
export function wechatAuthorization(i: AuthorizationInput): string {
  const message = `${i.method}\n${i.pathWithQuery}\n${String(i.timestamp)}\n${i.nonce}\n${i.body}\n`;
  const signature = rsaSha256Sign(message, i.privateKeyPem);
  return (
    `${SCHEMA} mchid="${i.mchid}",nonce_str="${i.nonce}",signature="${signature}",` +
    `timestamp="${String(i.timestamp)}",serial_no="${i.serialNo}"`
  );
}

export interface SignatureInput {
  readonly publicKeyPem: string;
  /** `Wechatpay-Timestamp` */
  readonly timestamp: string;
  /** `Wechatpay-Nonce` */
  readonly nonce: string;
  /** Raw body exactly as received. */
  readonly body: string;
  /** `Wechatpay-Signature` */
  readonly signature: string;
}

/** Verifies a response or notification signature. Probe signatures are rejected. */
export function verifyWechatSignature(i: SignatureInput): boolean {
  if (i.signature.startsWith('WECHATPAY/SIGNTEST/')) return false;
  const message = `${i.timestamp}\n${i.nonce}\n${i.body}\n`;
  try {
    return createVerify('RSA-SHA256')
      .update(message, 'utf8')
      .verify(i.publicKeyPem, i.signature, 'base64');
  } catch {
    return false;
  }
}

export interface EncryptedResource {
  readonly algorithm: string;
  readonly ciphertext: string;
  readonly nonce: string;
  readonly associated_data?: string;
}

/** AEAD_AES_256_GCM with the APIv3 key. Throws when the tag does not match. */
export function decryptWechatResource(apiV3Key: string, r: EncryptedResource): string {
  if (r.algorithm !== 'AEAD_AES_256_GCM') throw new Error('unsupported resource algorithm');
  const key = Buffer.from(apiV3Key, 'utf8');
  if (key.length !== 32) throw new Error('APIv3 key must be 32 bytes');
  const data = Buffer.from(r.ciphertext, 'base64');
  if (data.length < 16) throw new Error('ciphertext too short');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(r.nonce, 'utf8'));
  decipher.setAuthTag(data.subarray(data.length - 16));
  decipher.setAAD(Buffer.from(r.associated_data ?? '', 'utf8'));
  return Buffer.concat([
    decipher.update(data.subarray(0, data.length - 16)),
    decipher.final(),
  ]).toString('utf8');
}

export interface AppPaySignInput {
  readonly appId: string;
  /** Unix seconds. */
  readonly timestamp: number;
  readonly nonce: string;
  readonly prepayId: string;
  readonly privateKeyPem: string;
}

/** `sign` of the APP launch parameters. */
export function signAppPay(i: AppPaySignInput): string {
  return rsaSha256Sign(
    `${i.appId}\n${String(i.timestamp)}\n${i.nonce}\n${i.prepayId}\n`,
    i.privateKeyPem,
  );
}

/** RSAES-OAEP (SHA-1) with the WeChat Pay public key, for fields such as `user_name`. */
export function encryptSensitive(publicKeyPem: string, plaintext: string): string {
  return publicEncrypt(
    { key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
    Buffer.from(plaintext, 'utf8'),
  ).toString('base64');
}
