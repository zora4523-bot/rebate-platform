// Alipay OpenAPI primitives: RSA2 signing and verification, certificate serial numbers.
// Source: opendocs.alipay.com (mirrored privately, 2026-10-04). The certificate serial-number
// rule follows the official SDKs; not yet run against a live application (规划/09 CAP-X-06,
// CAP-X-17).
import { createHash, createSign, createVerify, X509Certificate } from 'node:crypto';

/** String to sign: drop `sign` and empty values, sort by key, join `k=v` with `&`, no encoding. */
export function alipaySignContent(params: Readonly<Record<string, string | undefined>>): string {
  return Object.keys(params)
    .filter((k) => k !== 'sign' && params[k] !== undefined && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k] ?? ''}`)
    .join('&');
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

const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

/** md5(issuer in RFC 2253 order + decimal serial number). */
export function certSn(certPem: string): string {
  const cert = new X509Certificate(certPem);
  // Node prints the issuer one RDN per line in certificate order; RFC 2253 is the reverse.
  const issuer = cert.issuer.split('\n').reverse().join(',');
  const serial = BigInt(`0x${cert.serialNumber}`).toString(10);
  return createHash('md5')
    .update(issuer + serial, 'utf8')
    .digest('hex');
}

/** Root bundle: serial numbers of the RSA-signed certificates, joined with `_`. */
export function rootCertSn(bundlePem: string): string {
  const sns: string[] = [];
  for (const pem of bundlePem.match(PEM_CERT) ?? []) {
    const cert = new X509Certificate(pem);
    const oid = (cert as { signatureAlgorithmOid?: string }).signatureAlgorithmOid;
    const isRsa =
      oid === undefined
        ? cert.publicKey.asymmetricKeyType === 'rsa'
        : oid.startsWith('1.2.840.113549.1.1');
    if (isRsa) sns.push(certSn(pem));
  }
  if (sns.length === 0) throw new Error('no RSA certificate in the root bundle');
  return sns.join('_');
}

/** Public key (PEM) inside a certificate, e.g. the Alipay public-key certificate. */
export function publicKeyFromCert(certPem: string): string {
  return new X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

/** `yyyy-MM-dd HH:mm:ss` in +08:00, as the gateway expects. */
export function alipayTimestamp(epochMs: number): string {
  const d = new Date(epochMs + 8 * 3_600_000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${String(d.getUTCFullYear())}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}
