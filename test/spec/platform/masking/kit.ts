// Shared helpers of the platform/masking rule tests (规划/08 BR-ID-33: 日志中不得出现明文). The
// logger under test is the real root logger writing JSON lines into memory; nothing is mocked.
//
// How a log line is judged (contract in apps/api/src/modules/platform/masking/index.ts):
//   1. `expectLine` parses the raw line with `parseStrict`, which rejects an object that has a
//      key twice (JSON.parse would silently keep the last one), checks `time` and `pid`, and
//      compares everything else with a hand-built expected record by deep equality. Every
//      sensitive value must be exactly "[REDACTED]"; `msg`, error messages and stacks must be
//      exactly what the test passed; no field may be added, dropped or changed. This pins every
//      key and value of the line; only the order of keys and the JSON spelling are free.
//   2. Independently of how the expected record was built, every key with a sensitive name, at
//      any depth of the parsed line, must hold exactly "[REDACTED]".
//   3. `leaksIn` is only a second net: it searches the raw line for plaintext pieces of the
//      samples. The verdict never depends on it alone.
import { expect } from 'vitest';
import {
  PinoNestLogger,
  createRootLogger,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/logging/index.ts';

/** The only value a sensitive field may have in a log line. */
export const REDACTED = '[REDACTED]';

/** Distinctive synthetic values; none shares a piece with another field by accident. */
export const SAMPLES = {
  phone: '13987654321',
  alipayPhone: '18603159742',
  contactPhone: '15822446688',
  alertPhone: '17705162430',
  idNo: '11010519491231002X',
  idNo15: '320105791231247',
  birthDate: '1949-12-31',
  realName: '张小三',
  payeeName: '欧阳明月',
  alipayEmail: 'qzx7.vwk3@exmpl-host.cn',
  bankCard: '6222021234567890123',
  cardNo: '4392260012345678',
  credential: 'zq7X v2Lk 9Pw4 Rt6Y',
} as const;

export type SampleName = keyof typeof SAMPLES;

export function sampleNames(): SampleName[] {
  return Object.keys(SAMPLES) as SampleName[];
}

/**
 * Every sensitive name of the contract with a sample value of its kind. Kept here, not imported,
 * so the contract cannot shrink under the tests.
 */
export function sensitiveFields(): Record<string, unknown> {
  return {
    phone: SAMPLES.phone,
    phones: [SAMPLES.phone, SAMPLES.alertPhone],
    mobile: SAMPLES.phone,
    mobile_phone: SAMPLES.phone,
    phone_number: SAMPLES.phone,
    contact_phone: SAMPLES.contactPhone,
    auth_alert_phones: [SAMPLES.alertPhone],
    id_no: SAMPLES.idNo,
    id_card: SAMPLES.idNo15,
    id_card_no: SAMPLES.idNo,
    id_number: SAMPLES.idNo15,
    birth_date: SAMPLES.birthDate,
    real_name: SAMPLES.realName,
    realname: { name: SAMPLES.realName, id_no: SAMPLES.idNo, birth_date: SAMPLES.birthDate },
    payee_name: SAMPLES.payeeName,
    alipay_logon_id: SAMPLES.alipayEmail,
    alipay_account: SAMPLES.alipayPhone,
    bank_card_no: SAMPLES.bankCard,
    card_no: SAMPLES.cardNo,
    payee_account: SAMPLES.bankCard,
    authorization: SAMPLES.credential,
    cookie: SAMPLES.credential,
    'set-cookie': SAMPLES.credential,
    password: SAMPLES.credential,
    token: SAMPLES.credential,
    access_token: SAMPLES.credential,
    refresh_token: SAMPLES.credential,
    step_up_token: SAMPLES.credential,
    'x-step-up-token': SAMPLES.credential,
    'x-sign': SAMPLES.credential,
    secret: SAMPLES.credential,
  };
}

/** What `sensitiveFields()` must look like in a log line: the same keys, each "[REDACTED]". */
export function redactedFields(): Record<string, unknown> {
  return Object.fromEntries(Object.keys(sensitiveFields()).map((key) => [key, REDACTED]));
}

/** Non-sensitive fields that must come out unchanged next to the sensitive ones. */
export const KEPT = {
  order_id: 'order-kept-a',
  amount_fen: 1999,
  user_id: 42,
  name: 'route-a',
  phone_bound: true,
} as const;

/** `key` rewritten in another spelling: camel (bankCardNo), upper (BANK_CARD_NO), kebab. */
export function respell(key: string, style: 'camel' | 'upper' | 'kebab'): string {
  const words = key.split(/[-_]/);
  if (style === 'upper') return words.join('_').toUpperCase();
  if (style === 'kebab') return words.join('-');
  return words.map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join('');
}

/** `value` wrapped in `depth` levels of objects (depth 1 = { level1: value }). */
export function nest(depth: number, value: unknown): Record<string, unknown> {
  let current = value;
  for (let level = depth; level >= 1; level -= 1) current = { [`level${String(level)}`]: current };
  return current as Record<string, unknown>;
}

/** An error carrying every kind of personal data as enumerable own properties. */
export function errorWithPersonalData(message: string): Error {
  return Object.assign(new Error(message), {
    phone: SAMPLES.phone,
    id_no: SAMPLES.idNo,
    real_name: SAMPLES.realName,
    bank_card_no: SAMPLES.bankCard,
    details: { alipay_logon_id: SAMPLES.alipayEmail, payee_name: SAMPLES.payeeName },
  });
}

/** The enumerable own properties of `errorWithPersonalData` as they must be written. */
export function redactedErrorProps(): Record<string, unknown> {
  return {
    phone: REDACTED,
    id_no: REDACTED,
    real_name: REDACTED,
    bank_card_no: REDACTED,
    details: { alipay_logon_id: REDACTED, payee_name: REDACTED },
  };
}

/** An error as the contract writes it: type, its own message and stack unchanged, then `more`. */
export function errorShape(
  type: string,
  error: Error,
  more: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type, message: error.message, stack: error.stack, ...more };
}

/** Own keys (symbols included), message, stack and enumerable content: to prove nothing changed. */
export function snapshotOf(value: object): unknown {
  return {
    keys: Reflect.ownKeys(value).map((key) => String(key)),
    json: JSON.stringify(value),
    message: value instanceof Error ? value.message : null,
    stack: value instanceof Error ? (value.stack ?? null) : null,
  };
}

/** JSON.parse that throws when one object has the same key twice, at any depth. */
export function parseStrict(text: string): unknown {
  let at = 0;
  const fail = (what: string): never => {
    throw new SyntaxError(`${what} at ${String(at)}`);
  };
  const skip = (): void => {
    while (' \t\n\r'.includes(text.charAt(at)) && at < text.length) at += 1;
  };
  const token = (pattern: RegExp): string => {
    const sticky = new RegExp(pattern.source, 'y');
    sticky.lastIndex = at;
    const match = sticky.exec(text);
    if (match === null) return fail('unexpected token');
    at = sticky.lastIndex;
    return match[0];
  };
  // JSON.parse of each string token rejects raw control characters and bad escapes.
  const STRING = /"(?:[^"\\]|\\.)*"/;
  const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?/;
  const WORD = /true|false|null/;
  const value = (): unknown => {
    skip();
    const c = text.charAt(at);
    if (c === '{') {
      at += 1;
      const out: Record<string, unknown> = {};
      const seen = new Set<string>();
      skip();
      if (text.charAt(at) === '}') {
        at += 1;
        return out;
      }
      for (;;) {
        skip();
        const key = JSON.parse(token(STRING)) as string;
        if (seen.has(key)) fail(`duplicate key ${JSON.stringify(key)}`);
        seen.add(key);
        skip();
        if (text.charAt(at) !== ':') fail('expected ":"');
        at += 1;
        Object.defineProperty(out, key, {
          value: value(),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        skip();
        if (text.charAt(at) === ',') {
          at += 1;
          continue;
        }
        if (text.charAt(at) !== '}') fail('expected "," or "}"');
        at += 1;
        return out;
      }
    }
    if (c === '[') {
      at += 1;
      const out: unknown[] = [];
      skip();
      if (text.charAt(at) === ']') {
        at += 1;
        return out;
      }
      for (;;) {
        out.push(value());
        skip();
        if (text.charAt(at) === ',') {
          at += 1;
          continue;
        }
        if (text.charAt(at) !== ']') fail('expected "," or "]"');
        at += 1;
        return out;
      }
    }
    if (c === '"') return JSON.parse(token(STRING)) as unknown;
    if (c === 't' || c === 'f' || c === 'n') return JSON.parse(token(WORD)) as unknown;
    return JSON.parse(token(NUMBER)) as unknown;
  };
  const result = value();
  skip();
  if (at !== text.length) fail('trailing text');
  return result;
}

/** A sensitive name of the contract, compared the contract's way (lower case, letters and digits). */
const SENSITIVE_NAMES = new Set(Object.keys(sensitiveFields()).map(normalizedName));

function normalizedName(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Values found under sensitive names anywhere in a parsed line that are not "[REDACTED]". */
export function unredacted(value: unknown, path = '$'): string[] {
  if (Array.isArray(value))
    return value.flatMap((item, i) => unredacted(item, `${path}[${String(i)}]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const here = `${path}.${key}`;
    if (SENSITIVE_NAMES.has(normalizedName(key)) && item !== REDACTED) return [here];
    return unredacted(item, here);
  });
}

const NAMES: readonly SampleName[] = ['realName', 'payeeName'];

/** Plaintext pieces of a sample: whole value, runs of 5 digits, 2 characters of a name, bytes. */
export function fragmentsOf(name: SampleName): string[] {
  const value = SAMPLES[name];
  const out = new Set<string>([value]);
  const flat = value.replace(/[-\s]/g, '');
  out.add(flat);
  if (/^[0-9Xx]+$/.test(flat)) {
    for (let i = 0; i + 5 <= flat.length; i += 1) out.add(flat.slice(i, i + 5));
  }
  if (NAMES.includes(name)) {
    const chars = [...value];
    for (let i = 0; i + 2 <= chars.length; i += 1) out.add(chars.slice(i, i + 2).join(''));
  }
  const bytes = Buffer.from(value, 'utf8');
  out.add(bytes.toString('hex'));
  out.add(bytes.toString('base64').replace(/=+$/, ''));
  out.add(Array.from(bytes).join(','));
  return [...out];
}

/** The raw line without the base fields, whose digits could match by chance. */
export function searchable(line: string): string {
  return line
    .replace(/"(time|hostname|entry|env)":"(?:[^"\\]|\\.)*"/g, '')
    .replace(/"pid":-?\d+/g, '');
}

/** Second net only: names of the samples whose plaintext pieces occur in the raw `line`. */
export function leaksIn(line: string, names: readonly SampleName[] = sampleNames()): string[] {
  const text = searchable(line);
  return names.filter((name) => fragmentsOf(name).some((fragment) => text.includes(fragment)));
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The exact check of one log line: one JSON document ending in "\n", no key twice in an object,
 * `time` an ISO instant, `pid` this process, and everything else deep-equal to
 * { entry: 'spec', env: 'test', ...expected }. Then the independent sensitive-name walk and the
 * plaintext search.
 */
export function expectLine(line: string | undefined, expected: Record<string, unknown>): void {
  expect(typeof line === 'string' && line.endsWith('\n')).toBe(true);
  const record = parseStrict(line ?? '') as Record<string, unknown>;
  const { time, pid, ...rest } = record;
  expect({ time: ISO_TIME.test(String(time)), pid }).toEqual({ time: true, pid: process.pid });
  expect(rest).toStrictEqual({ entry: 'spec', env: 'test', ...expected });
  expect(unredacted(record)).toEqual([]);
  expect(leaksIn(line ?? '')).toEqual([]);
}

export interface Captured {
  readonly logger: RootLogger;
  readonly lines: string[];
}

/** The real root logger writing into memory (level `trace`, so every level is kept). */
export function capture(): Captured {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'spec', appEnv: 'test' },
    {
      write(chunk: string): void {
        lines.push(chunk);
      },
    },
  );
  return { logger, lines };
}

/** A Nest logger adapter over a fresh in-memory root logger. */
export function captureNest(): Captured & { readonly nest: PinoNestLogger } {
  const captured = capture();
  return { ...captured, nest: new PinoNestLogger(captured.logger) };
}
