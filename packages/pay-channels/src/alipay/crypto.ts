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

/** Attribute short names, as the official SDKs print them. Unknown types fail closed. */
const SHORT_NAMES: Readonly<Record<string, string>> = {
  '2.5.4.3': 'CN',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '1.2.840.113549.1.9.1': 'E',
};

interface Tlv {
  readonly tag: number;
  readonly value: Buffer;
  /** Offset just past this element. */
  readonly end: number;
}

function readTlv(buf: Buffer, at: number): Tlv {
  const tag = buf[at];
  const first = buf[at + 1];
  if (tag === undefined || first === undefined) throw new Error('truncated DER');
  let length = first;
  let start = at + 2;
  if (first & 0x80) {
    const n = first & 0x7f;
    if (n === 0 || n > 4) throw new Error('unsupported DER length');
    length = 0;
    for (let i = 0; i < n; i += 1) {
      const b = buf[start + i];
      if (b === undefined) throw new Error('truncated DER');
      length = length * 256 + b;
    }
    start += n;
  }
  if (start + length > buf.length) throw new Error('truncated DER');
  return { tag, value: buf.subarray(start, start + length), end: start + length };
}

function children(buf: Buffer): Tlv[] {
  const out: Tlv[] = [];
  for (let at = 0; at < buf.length;) {
    const tlv = readTlv(buf, at);
    out.push(tlv);
    at = tlv.end;
  }
  return out;
}

function decodeOid(value: Buffer): string {
  const first = value[0];
  if (first === undefined) throw new Error('empty OID');
  const parts = [Math.floor(first / 40), first % 40];
  let acc = 0;
  for (const b of value.subarray(1)) {
    acc = acc * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) {
      parts.push(acc);
      acc = 0;
    }
  }
  return parts.join('.');
}

/** Decodes an ASN.1 string by its tag. Types that are not implemented fail closed. */
export function decodeDerString(tag: number, value: Buffer): string {
  switch (tag) {
    case 0x0c: // UTF8String
      return new TextDecoder('utf-8', { fatal: true }).decode(value);
    case 0x13: // PrintableString
    case 0x16: // IA5String
      if (value.some((b) => b > 0x7f)) throw new Error('non-ASCII byte in an ASCII string');
      return value.toString('latin1');
    case 0x14: // TeletexString (T61String): read as ISO 8859-1, as the common decoders do
      return value.toString('latin1');
    case 0x1c: {
      // UniversalString: UTF-32BE
      if (value.length % 4 !== 0) throw new Error('malformed UniversalString');
      let out = '';
      for (let i = 0; i < value.length; i += 4) out += String.fromCodePoint(value.readUInt32BE(i));
      return out;
    }
    case 0x1e: // BMPString: UTF-16BE
      if (value.length % 2 !== 0) throw new Error('malformed BMPString');
      return Buffer.from(value).swap16().toString('utf16le');
    default:
      throw new Error(`ASN.1 string type 0x${tag.toString(16)} is not supported`);
  }
}

function decodeString(tlv: Tlv): string {
  return decodeDerString(tlv.tag, tlv.value);
}

interface CertFields {
  /** Issuer attributes in certificate order. */
  readonly issuer: readonly { readonly shortName: string; readonly value: string }[];
  readonly serialHex: string;
  readonly signatureOid: string;
}

function parseCert(certPem: string): CertFields {
  const der = new X509Certificate(certPem).raw;
  const [tbs, sigAlg] = children(readTlv(der, 0).value);
  if (tbs === undefined || sigAlg === undefined) throw new Error('malformed certificate');
  const fields = children(tbs.value);
  // tbsCertificate: [0] version (optional), serialNumber, signature, issuer, ...
  const offset = fields[0]?.tag === 0xa0 ? 1 : 0;
  const serial = fields[offset];
  const issuerSeq = fields[offset + 2];
  const sigOid = children(sigAlg.value)[0];
  if (serial === undefined || issuerSeq === undefined || sigOid === undefined)
    throw new Error('malformed certificate');
  const issuer: { shortName: string; value: string }[] = [];
  for (const rdn of children(issuerSeq.value)) {
    for (const attr of children(rdn.value)) {
      const [type, value] = children(attr.value);
      if (type === undefined || value === undefined) throw new Error('malformed issuer');
      const oid = decodeOid(type.value);
      const shortName = SHORT_NAMES[oid];
      if (shortName === undefined) throw new Error(`issuer attribute ${oid} is not supported`);
      issuer.push({ shortName, value: decodeString(value) });
    }
  }
  return { issuer, serialHex: serial.value.toString('hex'), signatureOid: decodeOid(sigOid.value) };
}

function snOf(fields: CertFields): string {
  // Same rule as the official SDKs: attributes in reverse order as `shortName=value`, joined by
  // commas with the raw values (no escaping), followed by the decimal serial number.
  const issuer = [...fields.issuer]
    .reverse()
    .map((a) => `${a.shortName}=${a.value}`)
    .join(',');
  const serial = BigInt(`0x${fields.serialHex}`).toString(10);
  return createHash('md5')
    .update(issuer + serial, 'utf8')
    .digest('hex');
}

/** md5(issuer attributes reversed + decimal serial number). */
export function certSn(certPem: string): string {
  return snOf(parseCert(certPem));
}

/** Root bundle: serial numbers of the RSA-signed certificates, joined with `_`. */
export function rootCertSn(bundlePem: string): string {
  const blocks = bundlePem.match(PEM_CERT) ?? [];
  const begins = bundlePem.split('-----BEGIN CERTIFICATE-----').length - 1;
  const ends = bundlePem.split('-----END CERTIFICATE-----').length - 1;
  const leftover = bundlePem.replace(PEM_CERT, '').trim();
  if (begins !== blocks.length || ends !== blocks.length || leftover !== '') {
    throw new Error('root bundle is truncated or contains unexpected content');
  }
  const sns: string[] = [];
  for (const pem of blocks) {
    const fields = parseCert(pem);
    if (fields.signatureOid.startsWith('1.2.840.113549.1.1')) sns.push(snOf(fields));
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
