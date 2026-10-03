// Shared helpers of the platform/masking rule tests (规划/08 BR-ID-33: 日志中不得出现明文; 默认脱敏
// 格式). The logger under test is the real root logger writing JSON lines into memory; nothing is
// mocked. Leaks are searched in the RAW line (so a duplicated key cannot hide one), after
// removing the base fields (time, pid, hostname, entry, env) and every `stack` value (free text
// with line numbers). Each sample has the positions its default masking may show (phone: first
// 3 and last 4; ID number: first and last; name: last; anything else: none). A line leaks a
// sample when any of these holds:
//   - it contains the whole value, a run of 5 of its digits, or its UTF-8 bytes as hex, base64
//     or a JSON number list (a number or Buffer value);
//   - a string or number in it contains a piece of the value (3 or more characters, 2 for a
//     name) that covers a hidden position;
//   - a string or number in it has the value's length and repeats one of its characters at a
//     hidden position (1398***4321, 11**************2X, 张*三); two of them for a value without
//     a default masking.
import {
  PinoNestLogger,
  createRootLogger,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/logging/index.ts';

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

type Kind = 'phone' | 'id' | 'name' | 'secret';

const KIND: Record<SampleName, Kind> = {
  phone: 'phone',
  alipayPhone: 'secret',
  contactPhone: 'phone',
  alertPhone: 'phone',
  idNo: 'id',
  idNo15: 'id',
  birthDate: 'secret',
  realName: 'name',
  payeeName: 'name',
  alipayEmail: 'secret',
  bankCard: 'secret',
  cardNo: 'secret',
  credential: 'secret',
};

/** Positions (code points) of `name`'s value that its default masking does not show. */
export function hiddenPositions(name: SampleName): Set<number> {
  const length = [...SAMPLES[name]].length;
  const all = Array.from({ length }, (_, i) => i);
  switch (KIND[name]) {
    case 'phone':
      return new Set(all.filter((i) => i >= 3 && i < length - 4));
    case 'id':
      return new Set(all.filter((i) => i > 0 && i < length - 1));
    case 'name':
      return new Set(all.filter((i) => i < length - 1));
    default:
      return new Set(all);
  }
}

/** Strong fragments searched in the raw text: whole value, runs of 5 digits, UTF-8 bytes. */
export function fragmentsOf(value: string): string[] {
  const out = new Set<string>([value]);
  const flat = value.replace(/[-\s]/g, '');
  if (/^[0-9Xx]+$/.test(flat)) {
    for (let i = 0; i + 5 <= flat.length; i += 1) out.add(flat.slice(i, i + 5));
  }
  const bytes = Buffer.from(value, 'utf8');
  out.add(bytes.toString('hex'));
  out.add(bytes.toString('base64').replace(/=+$/, ''));
  out.add(Array.from(bytes).join(','));
  return [...out];
}

/** The raw line without base fields and `stack` values (their digits could match by chance). */
export function searchable(line: string): string {
  return line
    .replace(/"(time|hostname|entry|env)":"(?:[^"\\]|\\.)*"/g, '')
    .replace(/"pid":-?\d+/g, '')
    .replace(/"stack":"(?:[^"\\]|\\.)*"/g, '');
}

/** Every string literal (decoded, keys included, duplicates kept) and number of a raw line. */
export function tokensOf(text: string): string[] {
  const strings = [...text.matchAll(/"(?:[^"\\]|\\.)*"/g)].map((m) => JSON.parse(m[0]) as string);
  const rest = text.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const numbers = [...rest.matchAll(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g)].map((m) => m[0]);
  return [...strings, ...numbers];
}

function leaksSample(text: string, tokens: readonly string[], name: SampleName): boolean {
  const value = SAMPLES[name];
  if (fragmentsOf(value).some((fragment) => text.includes(fragment))) return true;
  const chars = [...value];
  const hidden = hiddenPositions(name);
  const minPiece = KIND[name] === 'name' ? 2 : 3;
  const pieces: string[] = [];
  for (let from = 0; from < chars.length; from += 1) {
    for (let to = from + minPiece; to <= chars.length; to += 1) {
      let coversHidden = false;
      for (let i = from; i < to; i += 1) if (hidden.has(i)) coversHidden = true;
      if (coversHidden) pieces.push(chars.slice(from, to).join(''));
    }
  }
  // A value without a default masking (account, e-mail, credential) needs two repeated hidden
  // characters, so that an unrelated text of the same length cannot match by one letter.
  const enough = KIND[name] === 'secret' ? 2 : 1;
  return tokens.some((token) => {
    if (pieces.some((piece) => token.includes(piece))) return true;
    const got = [...token];
    if (got.length !== chars.length) return false;
    return [...hidden].filter((i) => got[i] === chars[i]).length >= enough;
  });
}

/** Names of the samples that leak into `line` (empty when nothing leaks). */
export function leaksIn(line: string, names: readonly SampleName[] = sampleNames()): string[] {
  const text = searchable(line);
  const tokens = tokensOf(text);
  return names.filter((name) => leaksSample(text, tokens, name));
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
