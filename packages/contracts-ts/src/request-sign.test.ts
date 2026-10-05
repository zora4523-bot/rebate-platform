// BR-ID-09 at SPEC_REF: independent consistency checks for the shared client/server vectors.
// JSON layout: { $comment, version: 1, valid_cases: ValidCase[], invalid_cases: InvalidCase[] }.
// body_utf8 is the exact body text encoded as UTF-8, without JSON parsing or reserialization;
// empty text means zero bytes. install_secret is also UTF-8 text, visibly prefixed with test-.
// timestamp is the literal X-Timestamp string; server_time is an injected Unix-second integer.
// method is the canonical signing-string component, not a raw client API method argument:
// lowercase here is a malformed signing component; clients may uppercase their input first.
// Each invalid case isolates one expected_reason below; no live clock or replay store is used.
// Invalid-case expected_sign, when present, signs every field verbatim (no method uppercasing
// or host stripping). method_case and path_domain therefore cause signature mismatches at
// the server, which uses the uppercase method and host-free request path per BR-ID-09.
// Fixture field order: never place nonce or another 32/40-digit hex field immediately after
// install_secret: the cn-hex-secret gitleaks rule also inspects the following line.
import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

type RequestCase = {
  note: string;
  method: string;
  path: string;
  body_utf8: string;
  timestamp: string;
  server_time: number;
  nonce: string;
  install_secret: string;
};
type ValidCase = RequestCase & { expected_signing_string: string; expected_sign: string };
const failureReasons = [
  'timestamp_format',
  'time_skew',
  'nonce_length',
  'nonce_case',
  'nonce_hex',
  'method_case',
  'path_domain',
] as const;
type FailureReason = (typeof failureReasons)[number];
type InvalidCase = RequestCase & { expected_reason: FailureReason; expected_sign?: string };
type Vectors = {
  $comment: string;
  version: number;
  valid_cases: ValidCase[];
  invalid_cases: InvalidCase[];
};

function readVectors(): Vectors {
  const file = new URL('../../../specs/request-sign.vectors.json', import.meta.url);
  // Called inside every it: a missing fixture must fail assertions, not suite collection.
  expect(existsSync(file), '缺少 specs/request-sign.vectors.json（等待实现者提供向量）').toBe(true);
  const raw = readFileSync(file, 'utf8');
  expect(() => JSON.parse(raw), '向量必须是有效 JSON').not.toThrow();
  const vectors = JSON.parse(raw) as Vectors;
  expect(vectors).toBeTypeOf('object');
  expect(vectors).not.toBeNull();
  expect(vectors.$comment).toBeTypeOf('string');
  expect(vectors.$comment.trim()).not.toBe('');
  expect(vectors.version).toBe(1);
  for (const cases of [vectors.valid_cases, vectors.invalid_cases]) {
    expect(Array.isArray(cases)).toBe(true);
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(c).toBeTypeOf('object');
      expect(c).not.toBeNull();
      for (const key of [
        'note',
        'method',
        'path',
        'body_utf8',
        'timestamp',
        'nonce',
        'install_secret',
      ] as const) {
        expect(c[key], key).toBeTypeOf('string');
      }
      expect(c.note.trim()).not.toBe('');
      expect(Number.isSafeInteger(c.server_time), c.note).toBe(true);
    }
  }
  for (const c of vectors.valid_cases) {
    expect(c.expected_signing_string, c.note).toBeTypeOf('string');
    expect(c.expected_sign, c.note).toBeTypeOf('string');
  }
  for (const c of vectors.invalid_cases) {
    expect(failureReasons, c.note).toContain(c.expected_reason);
  }
  return vectors;
}

function signingString(c: RequestCase): string {
  const bodyHash = createHash('sha256').update(Buffer.from(c.body_utf8, 'utf8')).digest('hex');
  // Do not parse the path with URL/URLSearchParams: preserve query bytes and parameter order.
  return [c.method, c.path, c.timestamp, c.nonce, bodyHash].join('\n');
}

function failures(c: RequestCase): FailureReason[] {
  const reasons: FailureReason[] = [];
  const timestampValid = c.timestamp.length === 10 && /^[0-9]{10}$/.test(c.timestamp);
  if (!timestampValid) reasons.push('timestamp_format');
  // Check skew independently, even for malformed numeric syntax; a nonnumeric value has
  // no usable skew and violates only timestamp_format. Format fixtures must isolate it.
  const timestamp = Number(c.timestamp.trim());
  if (Number.isFinite(timestamp) && Math.abs(c.server_time - timestamp) > 300) {
    reasons.push('time_skew');
  }
  if (c.nonce.length !== 32) reasons.push('nonce_length');
  // Character membership and case do not depend on length (or on each other).
  if (/[^0-9a-f]/i.test(c.nonce)) reasons.push('nonce_hex');
  if (c.nonce !== c.nonce.toLowerCase()) reasons.push('nonce_case');
  if (c.method !== c.method.toUpperCase()) reasons.push('method_case');
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(c.path)) reasons.push('path_domain');
  return reasons;
}

it('[AC-CT-15k#1] 向量文件存在且结构完整', () => {
  const vectors = readVectors();
  expect(vectors.valid_cases.length).toBeGreaterThan(0);
  expect(vectors.invalid_cases.length).toBeGreaterThan(0);
});

it('[AC-CT-15k#2] 正例签名串与 HMAC-SHA256 独立计算一致', () => {
  for (const c of readVectors().valid_cases) {
    expect(failures(c), c.note).toEqual([]);
    expect(c.method, c.note).toMatch(/^[A-Z]+$/);
    expect(c.path.startsWith('/'), c.note).toBe(true);
    const canonical = signingString(c);
    expect(c.expected_signing_string, c.note).toBe(canonical);
    const digest = createHmac('sha256', Buffer.from(c.install_secret, 'utf8'))
      .update(canonical, 'utf8')
      .digest('hex');
    expect(c.expected_sign, c.note).toHaveLength(64);
    expect(c.expected_sign, c.note).toMatch(/^[0-9a-f]{64}$/);
    expect(c.expected_sign, c.note).toBe(digest);
  }
});

it('[AC-CT-15k#3] 正例覆盖原始 query、空 body 与非 ASCII body', () => {
  const cases = readVectors().valid_cases;
  expect(cases.some((c) => c.path.includes('?'))).toBe(true);
  expect(cases.some((c) => c.body_utf8 === '')).toBe(true);
  expect(cases.some((c) => /[^\x00-\x7f]/u.test(c.body_utf8))).toBe(true);
});

it('[AC-CT-15k#4] query 编码和参数顺序原样进入签名串', () => {
  // A deliberately unsorted, percent-encoded query catches both sorting and decoding.
  const cases = readVectors().valid_cases.filter((c) => c.path.endsWith('?b=2&a=1&c=%E4%B8%AD'));
  expect(cases.length).toBeGreaterThan(0);
  for (const c of cases) {
    expect(c.expected_signing_string.split('\n')[1], c.note).toBe(c.path);
    expect(c.expected_signing_string, c.note).toBe(signingString(c));
  }
});

it('[AC-CT-15k#5] 时间偏差正负 300 秒通过、正负 301 秒拒绝', () => {
  const vectors = readVectors();
  for (const delta of [-300, 300]) {
    const cases = vectors.valid_cases.filter((c) => c.server_time - Number(c.timestamp) === delta);
    expect(cases.length, `正例偏差 ${delta}`).toBeGreaterThan(0);
    for (const c of cases) expect(failures(c), c.note).toEqual([]);
  }
  for (const delta of [-301, 301]) {
    const cases = vectors.invalid_cases.filter(
      (c) => c.expected_reason === 'time_skew' && c.server_time - Number(c.timestamp) === delta,
    );
    expect(cases.length, `反例偏差 ${delta}`).toBeGreaterThan(0);
    for (const c of cases) expect(failures(c), c.note).toEqual(['time_skew']);
  }
});

it('[AC-CT-15k#6] 每条反例只违反标注规则，若提供签名则按字段原样计算', () => {
  for (const c of readVectors().invalid_cases) {
    expect.soft(failures(c), c.note).toEqual([c.expected_reason]);
    if ('expected_sign' in c) {
      const digest = createHmac('sha256', Buffer.from(c.install_secret, 'utf8'))
        .update(signingString(c), 'utf8')
        .digest('hex');
      expect.soft(c.expected_sign, c.note).toBe(digest);
    }
  }
});

it('[AC-CT-15k#7] 反例覆盖时间格式、nonce 格式、小写签名 method 和带域名 path', () => {
  const cases = readVectors().invalid_cases;
  expect(new Set(cases.map((c) => c.expected_reason))).toEqual(new Set(failureReasons));
  // Exercise both sides of fixed-width checks, and non-integer timestamp syntax separately.
  expect(cases.some((c) => c.expected_reason === 'nonce_length' && c.nonce.length < 32)).toBe(true);
  expect(cases.some((c) => c.expected_reason === 'nonce_length' && c.nonce.length > 32)).toBe(true);
  const timestamps = cases.filter((c) => c.expected_reason === 'timestamp_format');
  expect(timestamps.some((c) => /^[0-9]+$/.test(c.timestamp) && c.timestamp.length < 10)).toBe(
    true,
  );
  expect(timestamps.some((c) => /^[0-9]+$/.test(c.timestamp) && c.timestamp.length > 10)).toBe(
    true,
  );
  expect(timestamps.some((c) => /[^0-9]/.test(c.timestamp))).toBe(true);
  expect(
    timestamps.some((c) => Number.isNaN(Number(c.timestamp.trim()))),
    '至少一个无法解析成数字的时间戳反例',
  ).toBe(true);
  expect(
    cases.some((c) => c.expected_reason === 'path_domain' && c.path.startsWith('//')),
    '至少一个以 // 开头的带域名 path 反例',
  ).toBe(true);
});

it('[AC-CT-15k#8] 所有 install_secret 均为明显的测试值', () => {
  const vectors = readVectors();
  for (const c of [...vectors.valid_cases, ...vectors.invalid_cases]) {
    expect(c.install_secret.startsWith('test-'), c.note).toBe(true);
    expect(c.install_secret, c.note).toMatch(/[^A-Za-z0-9_-]/);
    // contracts/openapi.yaml RegisterDeviceData.install_secret: 16..128 characters.
    expect([...c.install_secret].length, c.note).toBeGreaterThanOrEqual(16);
    expect([...c.install_secret].length, c.note).toBeLessThanOrEqual(128);
  }
});

it('[AC-CT-15k#9] 正例覆盖 PUT 签名', () => {
  expect(readVectors().valid_cases.some((c) => c.method === 'PUT')).toBe(true);
});

it('[AC-CT-15k#10] 正例覆盖超过 64 字节的 HMAC 密钥', () => {
  expect(
    readVectors().valid_cases.some((c) => Buffer.byteLength(c.install_secret, 'utf8') > 64),
  ).toBe(true);
});

it('[AC-CT-15k#11] 正例覆盖小写百分号编码与重复 query 参数', () => {
  const cases = readVectors().valid_cases;
  // Inspect the raw query only: URLSearchParams would decode/normalize the evidence.
  const queries = cases.filter((c) => c.path.includes('?')).map((c) => c.path.split('?')[1]!);
  expect(queries.some((query) => /%(?:[a-f][0-9a-f]|[0-9][a-f])/.test(query))).toBe(true);
  expect(
    queries.some((query) => {
      const names = query.split('&').map((parameter) => parameter.split('=')[0]);
      return new Set(names).size < names.length;
    }),
  ).toBe(true);
});
