// B2-15k: Alipay RSA2 primitives, ported from task/PAY-01 packages/pay-channels. Documents, not yet
// run against an application (BR-PAY-09): request signature docs-mirror/alipay/app-pay/02e7gq.md
// (sign_type RSA2); a synchronous answer is verified over the raw text of its `xxx_response` node
// (docs-mirror/alipay/guides/browser-02mse7.md:23-31); a notification over every decoded parameter
// but sign and sign_type, sorted (docs-mirror/alipay/app-pay/00dn78.md:110-114).
// Also compiled by the `test` project: erasable syntax only.
import { createSign, createVerify } from 'node:crypto';

function sortedPairs(params: Readonly<Record<string, string>>, keys: readonly string[]): string {
  return [...keys]
    .sort()
    .map((key) => `${key}=${params[key] ?? ''}`)
    .join('&');
}

/** The string a request signs: no `sign`, no empty value, sorted by key, nothing encoded. */
export function alipayRequestSignContent(params: Readonly<Record<string, string>>): string {
  return sortedPairs(
    params,
    Object.keys(params).filter((key) => key !== 'sign' && params[key] !== ''),
  );
}

/** The string a notification signs: everything but sign and sign_type (empty values included). */
export function alipayNotificationSignContent(params: Readonly<Record<string, string>>): string {
  return sortedPairs(
    params,
    Object.keys(params).filter((key) => key !== 'sign' && key !== 'sign_type'),
  );
}

export function rsa2Sign(content: string, privateKeyPem: string): string {
  return createSign('RSA-SHA256').update(content, 'utf8').sign(privateKeyPem, 'base64');
}

export function rsa2Verify(content: string, signature: string, publicKeyPem: string): boolean {
  try {
    return createVerify('RSA-SHA256')
      .update(content, 'utf8')
      .verify(publicKeyPem, signature, 'base64');
  } catch {
    return false;
  }
}
