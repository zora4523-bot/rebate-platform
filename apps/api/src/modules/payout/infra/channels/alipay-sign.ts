// B2-06b: Alipay open-platform RSA2 signing (D-W11: written here rather than taken from alipay-sdk,
// so the payout process carries no extra HTTP client or dependency). The canonical string is the
// gateway rule: parameters sorted by key in ASCII order, joined as k=v&, values unescaped, `sign`
// and empty values left out; signature = SHA256withRSA (PKCS#1 v1.5) over that string, base64.
// Responses are verified over the exact bytes of the response node, never a re-serialised object.
import { constants, createSign, createVerify } from 'node:crypto';

/** ASCII key ordering, unescaped values; omit the signature and empty values, retain sign_type=RSA2. */
export function canonicalAlipayParams(params: Readonly<Record<string, string>>): string {
  return Object.keys(params)
    .filter((key) => key !== 'sign' && params[key] !== undefined && params[key] !== '')
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((key) => `${key}=${params[key]}`)
    .join('&');
}

export function signAlipayParams(
  params: Readonly<Record<string, string>>,
  privateKey: string,
): string {
  const signer = createSign('RSA-SHA256');
  signer.update(canonicalAlipayParams(params), 'utf8');
  return signer.sign({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, 'base64');
}

/** Verify the original response node bytes, never a parsed-and-reserialized object. */
export function verifyAlipayResponse(
  responseNode: string,
  signature: string,
  publicKey: string,
): boolean {
  try {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(responseNode, 'utf8');
    return verifier.verify({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, signature, 'base64');
  } catch {
    // A malformed key or signature is a verification failure, not an exception for the caller.
    return false;
  }
}
