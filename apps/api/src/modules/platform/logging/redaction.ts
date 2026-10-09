import {
  isAnyArrayBuffer,
  isBigIntObject,
  isBooleanObject,
  isNumberObject,
  isStringObject,
} from 'node:util/types';

/** BR-ID-33: logs discard sensitive values entirely; display masks are not log masks. */
export const REDACTED = '[REDACTED]';

export const SENSITIVE_KEYS = Object.freeze([
  'phone',
  'phones',
  'mobile',
  'mobile_phone',
  'phone_number',
  'contact_phone',
  'auth_alert_phones',
  'id_no',
  'id_card',
  'id_card_no',
  'id_number',
  'birth_date',
  'real_name',
  'payee_name',
  'alipay_logon_id',
  'alipay_account',
  'bank_card_no',
  'card_no',
  'payee_account',
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'token',
  'access_token',
  'refresh_token',
  'step_up_token',
  'x-step-up-token',
  'x-sign',
  'secret',
  // Request-signing key of a device (BR-ID-09), returned once by POST /v1/devices.
  'install_secret',
  // Human-verification token of POST /v1/auth/sms-codes and an SMS verification code (BR-ID-05).
  'captcha_token',
  'sms_code',
  // The access-token signing key (BR-ID-07): JWT_PRIVATE_KEY_PEM and the parsed configuration's
  // privateKeyPem (keys are compared after normalizedKey, so private_key_pem covers both cases).
  'private_key_pem',
  'jwt_private_key_pem',
] as const);

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const sensitiveNames = new Set<string>(SENSITIVE_KEYS.map(normalizedKey));
const freeTextKeys = new Set(['msg', 'message', 'stack']);
const email =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const digit = '[0-9０-９]';
const id18 = `${digit}(?:[ -]?${digit}){16}(?:[ -]?${digit}|[Xx])`;
const bankCard = `${digit}(?:[ -]?${digit}){15,18}`;
const id15 = `${digit}(?:[ -]?${digit}){14}`;
const phone = `(?:(?:\\+[8８][6６]|[0０][0０][8８][6６]|[8８][6６])[ -]?)?[1１](?:[ -]?${digit}){10}`;
const personalNumber = new RegExp(
  `(?<!${digit})(?:${id18}|${bankCard}|${id15}|${phone})(?!${digit})`,
  'g',
);

/** A safety net for free text only: ordinary structured ids and amounts are untouched. */
export function redactText(text: string): string {
  return text.replace(email, REDACTED).replace(personalNumber, REDACTED);
}

/** Decode percent bytes once, retaining malformed escapes and replacing invalid UTF-8. */
function decodePathSegment(segment: string): string {
  if (!segment.includes('%')) return segment;
  const bytes = new TextEncoder().encode(segment);
  let length = 0;
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index]!;
    if (byte === 0x25) {
      const hex = String.fromCharCode(bytes[index + 1] ?? 0, bytes[index + 2] ?? 0);
      if (/^[0-9a-f]{2}$/i.test(hex)) {
        bytes[length++] = Number.parseInt(hex, 16);
        index += 2;
        continue;
      }
    }
    bytes[length++] = byte;
  }
  return new TextDecoder().decode(bytes.subarray(0, length));
}

/** URL paths and access-log templates share the same whole-segment safety net. */
export function redactPath(path: string): string {
  return path
    .split('/')
    .map((segment) => {
      if (redactText(segment) !== segment) return REDACTED;
      const decoded = decodePathSegment(segment);
      return redactText(decoded) !== decoded ? REDACTED : segment;
    })
    .join('/');
}

/** Unwrap blob URLs iteratively so nested origins are written once without recursive calls. */
function redactURL(url: URL): string {
  let prefix = '';
  while (url.protocol === 'blob:') {
    prefix += 'blob:';
    const path = url.pathname;
    try {
      url = new URL(path);
    } catch {
      return prefix + redactPath(path);
    }
  }
  return prefix + redactText(url.origin) + redactPath(url.pathname);
}

export const UNSERIALIZABLE = '[Unserializable]';

function isBoxed(value: unknown): value is { valueOf(): string | number | boolean | bigint } {
  return (
    isStringObject(value) ||
    isNumberObject(value) ||
    isBooleanObject(value) ||
    isBigIntObject(value)
  );
}

/** Read the wrapped primitive with the intrinsic valueOf: an own or overridden valueOf is ignored. */
function unbox(value: object): string | number | boolean | bigint {
  if (isStringObject(value)) return String.prototype.valueOf.call(value);
  if (isNumberObject(value)) return Number.prototype.valueOf.call(value);
  if (isBooleanObject(value)) return Boolean.prototype.valueOf.call(value);
  return BigInt.prototype.valueOf.call(value);
}

function isBinary(value: unknown): value is ArrayBufferLike | ArrayBufferView {
  return isAnyArrayBuffer(value) || ArrayBuffer.isView(value);
}

// Pino's hook and formatters may copy a record more than once. Preserve Error provenance
// without adding output fields, so an Error's numeric code never becomes free text under err.
const errorCopies = new WeakSet<object>();

/** Collect objects at every depth (bounded), without invoking getters. */
function collectObjects(root: unknown, visit: (item: object) => void): void {
  const seen = new Set<object>();
  const stack: Array<{ item: unknown; depth: number }> = [{ item: root, depth: 0 }];
  while (stack.length > 0) {
    const { item, depth } = stack.pop()!;
    if (item === null || typeof item !== 'object' || seen.has(item) || depth > 100) continue;
    seen.add(item);
    visit(item);
    for (const name of Object.keys(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, name);
      if (descriptor && 'value' in descriptor)
        stack.push({ item: descriptor.value, depth: depth + 1 });
    }
  }
}

function sameFields(left: object, right: object): boolean {
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((name) => {
    const a = Object.getOwnPropertyDescriptor(left, name);
    const b = Object.getOwnPropertyDescriptor(right, name);
    return !!a && !!b && 'value' in a && 'value' in b && Object.is(a.value, b.value);
  });
}

/**
 * A caller formatter may rebuild an Error copy ({ ...err }). A plain object in its output that
 * holds exactly the fields of an Error copy from its input keeps the Error provenance; any other
 * object (including an Error lookalike that never came from an Error) does not.
 */
export function retainErrorCopies(input: unknown, output: unknown): void {
  if (input === output) return;
  const copies: object[] = [];
  collectObjects(input, (item) => {
    if (errorCopies.has(item)) copies.push(item);
  });
  if (copies.length === 0) return;
  collectObjects(output, (item) => {
    if (errorCopies.has(item) || Object.getPrototypeOf(item) !== Object.prototype) return;
    if (copies.some((copy) => sameFields(item, copy))) errorCopies.add(item);
  });
}

/** Under an Error's own properties: personal data in text is replaced, other types are kept. */
function redactErrorScalar(value: string | number | bigint): string | number | bigint {
  if (typeof value === 'string') return redactText(value);
  const text = String(value);
  return redactText(text) === text ? value : REDACTED;
}

/** Resolve replacements at the same field depth; bound non-terminating toJSON chains too. */
function resolveJSON(value: unknown, chain: Set<object>, ancestors = new Set<object>()): unknown {
  while (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    if (ancestors.has(value) || chain.has(value)) return '[Circular]';
    if (chain.size > 100) return '[Truncated]';
    chain.add(value);
    // These types have explicit rules that take precedence over built-in/custom toJSON.
    if (value instanceof Error || value instanceof URL || isBinary(value) || isBoxed(value)) {
      return value;
    }
    const toJSON: unknown = Reflect.get(value, 'toJSON');
    if (typeof toJSON !== 'function') return value;
    const next: unknown = toJSON.call(value);
    if (next === value) return value;
    value = next;
  }
  return value;
}

/** Copy without mutating callers; free-text context follows descendants. */
export function redactValue(
  value: unknown,
  key = '',
  ancestors = new Set<object>(),
  depth = 0,
  freeText = false,
  errorText = false,
): unknown {
  if (sensitiveNames.has(normalizedKey(key))) return REDACTED;
  if (depth > 100) return '[Truncated]';
  const chain = new Set<object>();
  const visit = (item: unknown, name = '', inError = errorText) =>
    redactValue(item, name, ancestors, depth + 1, freeText, inError);
  const field = (name: string, inError = errorText) => {
    // Do not even invoke a getter for a sensitive field.
    if (sensitiveNames.has(normalizedKey(name))) return REDACTED;
    return attempt(() => visit(Reflect.get(value as object, name), name, inError));
  };
  try {
    value = resolveJSON(value, chain, ancestors);
    for (const item of chain) ancestors.add(item);
    const error =
      value instanceof Error ||
      (typeof value === 'object' && value !== null && errorCopies.has(value));
    freeText ||= freeTextKeys.has(key) || (key === 'err' && !error);
    if (isBinary(value)) return `[Binary ${String(value.byteLength)} bytes]`;
    if (value instanceof URL) value = redactURL(value);
    if (isBoxed(value)) value = unbox(value);
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
      if (freeText) return redactText(String(value));
      // Error properties (e.g. an HTTP client's response.data) keep their types but never
      // write personal data found by the free-text net.
      if (errorText) return redactErrorScalar(value);
    }
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
    if (value instanceof Error) {
      const original = value;
      const fields: Record<string, unknown> = {
        type: attempt(() => visit(original.constructor.name, 'type')),
        message: field('message'),
        stack: field('stack'),
        ...Object.fromEntries(Object.keys(value).map((name) => [name, field(name, true)])),
      };
      if ('errors' in value) {
        const errors = attempt(() => Reflect.get(original, 'errors') as unknown);
        if (Array.isArray(errors)) fields['aggregateErrors'] = visit(errors, '', true);
        else if (errors === UNSERIALIZABLE) fields['aggregateErrors'] = UNSERIALIZABLE;
      }
      if (Object.hasOwn(value, 'cause')) fields['cause'] = field('cause', true);
      errorCopies.add(fields);
      return fields;
    }
    if (typeof value === 'function') return undefined;
    if (Array.isArray(value)) {
      return Array.from({ length: value.length }, (_, index) => field(String(index)));
    }
    if (value instanceof Map || value instanceof Set) return {};
    const fields = Object.fromEntries(Object.keys(value).map((name) => [name, field(name)]));
    if (error) errorCopies.add(fields);
    return fields;
  } catch {
    return UNSERIALIZABLE;
  } finally {
    // Only ancestors count as circular: shared values in separate branches remain visible.
    for (const item of chain) ancestors.delete(item);
  }
}

export function attempt(read: () => unknown): unknown {
  try {
    return read();
  } catch {
    return UNSERIALIZABLE;
  }
}

export type FieldSerializers = Readonly<Record<string, (value: unknown) => unknown>>;

/** Serializers see original objects (including prototype getters), before any copying. */
export function redactRecord(
  value: object,
  serializers: FieldSerializers = {},
): Record<string, unknown> {
  const result = attempt(() => {
    const chain = new Set<object>();
    const record = resolveJSON(value, chain);
    // A log record/binding contributes fields, not a primitive message. In particular, do
    // not split a string result into indexed characters that bypass free-text redaction.
    if (
      record === null ||
      typeof record !== 'object' ||
      isBoxed(record) ||
      isBinary(record) ||
      record instanceof URL
    )
      return {};
    return Object.fromEntries(
      Object.keys(record).map((key) => [
        key,
        sensitiveNames.has(normalizedKey(key))
          ? REDACTED
          : attempt(() => {
              const original: unknown = Reflect.get(record, key);
              const serializer = Object.hasOwn(serializers, key) ? serializers[key] : undefined;
              return redactValue(
                serializer ? serializer(original) : original,
                key,
                new Set(chain),
                1,
              );
            }),
      ]),
    );
  });
  return typeof result === 'object' && result !== null
    ? (result as Record<string, unknown>)
    : { message: UNSERIALIZABLE };
}

/** Node 24 raw JSON preserves bigint as numeric JSON without rounding or throwing. */
export function stringifyValue(value: unknown): string | undefined {
  const json = JSON as typeof JSON & { rawJSON: (text: string) => unknown };
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? json.rawJSON(String(item)) : item,
  );
}

export function redactMessage(value: unknown): string {
  const safe = redactValue(value, 'msg');
  return redactText(
    typeof safe === 'string' || typeof safe === 'number' || typeof safe === 'boolean'
      ? String(safe)
      : (stringifyValue(safe) ?? ''),
  );
}
