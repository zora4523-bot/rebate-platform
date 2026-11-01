// B2-15k: Alipay certificate mode: serial numbers and the public key of a certificate
// (NotImplemented skeleton). The serial number rule follows the official SDKs (code review r3 of
// task/PAY-01, recorded in the rule test); not yet run against an application (BR-PAY-09).
// Also compiled by the `test` project: erasable syntax only.

/** md5(issuer attributes in reverse order as `name=rawValue`, comma-joined + decimal serial). */
export function certSn(certPem: string): string {
  void certPem;
  throw new Error('NotImplemented: certSn');
}

/** The root bundle: the serial numbers of its RSA-signed certificates, joined with `_`. */
export function rootCertSn(bundlePem: string): string {
  void bundlePem;
  throw new Error('NotImplemented: rootCertSn');
}

/** The public key (PEM) inside a certificate. */
export function publicKeyFromCert(certPem: string): string {
  void certPem;
  throw new Error('NotImplemented: publicKeyFromCert');
}
