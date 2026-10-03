// Shared helpers of the platform/masking rule tests (规划/08 BR-ID-33: 日志中不得出现明文; 默认脱敏
// 格式). The logger under test is the real root logger writing JSON lines into memory; nothing is
// mocked. A "leak" is any fragment of a sample value that the default masking would not show:
// for digit strings every run of 5 consecutive characters of the value, for names the whole name
// and the name without its last character, for e-mail addresses the address and its local part,
// and for every value its UTF-8 bytes printed as hex, base64 or a JSON number list (a Buffer
// value). The base fields `time`, `pid` and `hostname` are dropped before searching, so their
// digits cannot match by accident.
import {
  PinoNestLogger,
  createRootLogger,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/logging/index.ts';

/** Distinctive synthetic values; none is a substring of another field by accident. */
export const SAMPLES = {
  phone: '13987654321',
  alipayPhone: '18603159742',
  contactPhone: '15822446688',
  alertPhone: '17751239876',
  idNo: '11010519491231002X',
  idNo15: '320105791231247',
  birthDate: '1949-12-31',
  realName: '张小三',
  payeeName: '欧阳明月',
  alipayEmail: 'payee.rule.test@example.com',
  bankCard: '6222021234567890123',
  cardNo: '4392260012345678',
  credential: 'Bearer zq7Xv2Lk9Pw4Rt6Y',
} as const;

export type SampleName = keyof typeof SAMPLES;

/** Fragments of `value` that must not appear in a log line. */
export function fragmentsOf(value: string): string[] {
  const out = new Set<string>([value]);
  const chars = [...value];
  const flat = value.replace(/[-\s]/g, '');
  if (/^[0-9Xx]+$/.test(flat)) {
    for (let i = 0; i + 5 <= flat.length; i += 1) out.add(flat.slice(i, i + 5));
  } else if (value.includes('@')) {
    out.add(value.slice(0, value.indexOf('@')));
  } else if (chars.length >= 2 && !value.includes(' ')) {
    out.add(chars.slice(0, -1).join(''));
  } else if (value.includes(' ')) {
    // A credential such as "Bearer <token>": the token part alone is enough to leak.
    out.add(value.slice(value.lastIndexOf(' ') + 1));
  }
  const bytes = Buffer.from(value, 'utf8');
  out.add(bytes.toString('hex'));
  out.add(bytes.toString('base64').replace(/=+$/, ''));
  out.add(Array.from(bytes).join(','));
  return [...out];
}

/** The line without the base fields whose digits could collide with a sample (time, pid, host). */
export function searchable(line: string): string {
  const record = JSON.parse(line) as Record<string, unknown>;
  delete record['time'];
  delete record['pid'];
  delete record['hostname'];
  return JSON.stringify(record);
}

/** Names of the samples that leak into `line` (empty when nothing leaks). */
export function leaksIn(line: string, names: readonly SampleName[] = sampleNames()): string[] {
  const text = searchable(line);
  return names.filter((name) => fragmentsOf(SAMPLES[name]).some((f) => text.includes(f)));
}

export function sampleNames(): SampleName[] {
  return Object.keys(SAMPLES) as SampleName[];
}

export interface Captured {
  readonly logger: RootLogger;
  readonly lines: string[];
  records(): Record<string, unknown>[];
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
  return {
    logger,
    lines,
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** A Nest logger adapter over a fresh in-memory root logger. */
export function captureNest(): Captured & { readonly nest: PinoNestLogger } {
  const captured = capture();
  return { ...captured, nest: new PinoNestLogger(captured.logger) };
}

/**
 * Every sensitive name of the contract (apps/api/src/modules/platform/masking/index.ts) with a
 * sample value of its kind. Kept here, not imported, so the contract cannot shrink under the
 * tests.
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

/** Non-sensitive fields that must come out unchanged next to the sensitive ones. */
export const KEPT = {
  order_id: 'o-20261003-0001',
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
export function nest(depth: number, value: Record<string, unknown>): Record<string, unknown> {
  let current: Record<string, unknown> = value;
  for (let level = depth; level >= 1; level -= 1) current = { [`level${String(level)}`]: current };
  return current;
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
