// B2-15k: Alipay certificate mode: serial numbers and the public key of a certificate, ported from
// task/PAY-01. The serial number rule follows the official SDKs (code review r3 of task/PAY-01;
// docs-mirror/alipay/guides/browser-02mse7.md:54-57 only says what alipay_cert_sn is for); not yet
// run against an application (BR-PAY-09). r3 建议改 ①: the attribute values are the raw ones, a
// leading U+FEFF stays (ignoreBOM). Attribute and string types not implemented fail closed.
// Also compiled by the `test` project: erasable syntax only.
import { createHash, X509Certificate } from 'node:crypto';

const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
const RSA_SIGNATURE_OID_PREFIX = '1.2.840.113549.1.1';

/** Attribute short names, as the official SDKs print them. */
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

function readTlv(buffer: Buffer, at: number): Tlv {
  const tag = buffer[at];
  const first = buffer[at + 1];
  if (tag === undefined || first === undefined) throw new Error('truncated DER');
  let length = first;
  let start = at + 2;
  if ((first & 0x80) !== 0) {
    const count = first & 0x7f;
    if (count === 0 || count > 4) throw new Error('unsupported DER length');
    length = 0;
    for (let index = 0; index < count; index += 1) {
      const byte = buffer[start + index];
      if (byte === undefined) throw new Error('truncated DER');
      length = length * 256 + byte;
    }
    start += count;
  }
  if (start + length > buffer.length) throw new Error('truncated DER');
  return { tag, value: buffer.subarray(start, start + length), end: start + length };
}

function children(buffer: Buffer): readonly Tlv[] {
  const out: Tlv[] = [];
  for (let at = 0; at < buffer.length;) {
    const tlv = readTlv(buffer, at);
    out.push(tlv);
    at = tlv.end;
  }
  return out;
}

function decodeOid(value: Buffer): string {
  const first = value[0];
  if (first === undefined) throw new Error('empty OID');
  const parts = [Math.floor(first / 40), first % 40];
  let accumulated = 0;
  for (const byte of value.subarray(1)) {
    accumulated = accumulated * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      parts.push(accumulated);
      accumulated = 0;
    }
  }
  return parts.join('.');
}

/** An ASN.1 string by its tag. Types that are not implemented fail closed. */
export function decodeDerString(tag: number, value: Buffer): string {
  switch (tag) {
    case 0x0c: // UTF8String
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);
    case 0x13: // PrintableString
    case 0x16: // IA5String
      if (value.some((byte) => byte > 0x7f)) throw new Error('non-ASCII byte in an ASCII string');
      return value.toString('latin1');
    case 0x14: // TeletexString: read as ISO 8859-1, as the common decoders do
      return value.toString('latin1');
    case 0x1c: {
      // UniversalString: UTF-32BE
      if (value.length % 4 !== 0) throw new Error('malformed UniversalString');
      let out = '';
      for (let at = 0; at < value.length; at += 4)
        out += String.fromCodePoint(value.readUInt32BE(at));
      return out;
    }
    case 0x1e: // BMPString: UTF-16BE
      if (value.length % 2 !== 0) throw new Error('malformed BMPString');
      return Buffer.from(value).swap16().toString('utf16le');
    default:
      throw new Error('ASN.1 string type is not supported');
  }
}

interface CertFields {
  /** Issuer attributes in certificate order. */
  readonly issuer: readonly string[];
  readonly serialHex: string;
  readonly signatureOid: string;
}

function parseCert(certPem: string): CertFields {
  const der = new X509Certificate(certPem).raw;
  const [tbs, signatureAlgorithm] = children(readTlv(der, 0).value);
  if (tbs === undefined || signatureAlgorithm === undefined) {
    throw new Error('malformed certificate');
  }
  const fields = children(tbs.value);
  // tbsCertificate: [0] version (optional), serialNumber, signature, issuer, ...
  const offset = fields[0]?.tag === 0xa0 ? 1 : 0;
  const serial = fields[offset];
  const issuerSequence = fields[offset + 2];
  const signatureOid = children(signatureAlgorithm.value)[0];
  if (serial === undefined || issuerSequence === undefined || signatureOid === undefined) {
    throw new Error('malformed certificate');
  }
  const issuer: string[] = [];
  for (const rdn of children(issuerSequence.value)) {
    for (const attribute of children(rdn.value)) {
      const [type, value] = children(attribute.value);
      if (type === undefined || value === undefined) throw new Error('malformed issuer');
      const shortName = SHORT_NAMES[decodeOid(type.value)];
      if (shortName === undefined) throw new Error('issuer attribute is not supported');
      issuer.push(`${shortName}=${decodeDerString(value.tag, value.value)}`);
    }
  }
  return {
    issuer,
    serialHex: serial.value.toString('hex'),
    signatureOid: decodeOid(signatureOid.value),
  };
}

function snOf(fields: CertFields): string {
  const serial = BigInt(`0x${fields.serialHex}`).toString(10);
  return createHash('md5')
    .update(`${[...fields.issuer].reverse().join(',')}${serial}`, 'utf8')
    .digest('hex');
}

/** md5(issuer attributes in reverse order as `name=rawValue`, comma-joined + decimal serial). */
export function certSn(certPem: string): string {
  return snOf(parseCert(certPem));
}

/** The root bundle: the serial numbers of its RSA-signed certificates, joined with `_`. */
export function rootCertSn(bundlePem: string): string {
  const blocks = bundlePem.match(PEM_CERT) ?? [];
  const begins = bundlePem.split('-----BEGIN CERTIFICATE-----').length - 1;
  const ends = bundlePem.split('-----END CERTIFICATE-----').length - 1;
  if (
    begins !== blocks.length ||
    ends !== blocks.length ||
    bundlePem.replace(PEM_CERT, '').trim() !== ''
  ) {
    throw new Error('root bundle is truncated or contains unexpected content');
  }
  const serials = blocks
    .map(parseCert)
    .filter((fields) => fields.signatureOid.startsWith(RSA_SIGNATURE_OID_PREFIX))
    .map(snOf);
  if (serials.length === 0) throw new Error('no RSA certificate in the root bundle');
  return serials.join('_');
}

/** The public key (PEM) inside a certificate. */
export function publicKeyFromCert(certPem: string): string {
  return new X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'pem' }).toString();
}
