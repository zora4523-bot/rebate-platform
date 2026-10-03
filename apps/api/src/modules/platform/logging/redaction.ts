import { isBigIntObject, isBooleanObject, isNumberObject, isStringObject } from 'node:util/types';

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

export const UNSERIALIZABLE = '[Unserializable]';

/** Copy without mutating callers; free-text context follows descendants. */
export function redactValue(
  value: unknown,
  key = '',
  ancestors = new Set<object>(),
  depth = 0,
  freeText = false,
): unknown {
  if (sensitiveNames.has(normalizedKey(key))) return REDACTED;
  if (depth > 100) return '[Truncated]';
  freeText ||= freeTextKeys.has(key);
  if (
    freeText &&
    (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint')
  ) {
    return redactText(String(value));
  }
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  if (ancestors.has(value)) return '[Circular]';
  ancestors.add(value);
  const visit = (item: unknown, name = '') =>
    redactValue(item, name, ancestors, depth + 1, freeText);
  const field = (name: string) => {
    // Do not even invoke a getter for a sensitive field.
    if (sensitiveNames.has(normalizedKey(name))) return REDACTED;
    return attempt(() => visit(Reflect.get(value, name), name));
  };
  try {
    if (value instanceof Error) {
      const fields: Record<string, unknown> = {
        type: attempt(() => visit(value.constructor.name, 'type')),
        message: field('message'),
        stack: field('stack'),
        ...Object.fromEntries(Object.keys(value).map((name) => [name, field(name)])),
      };
      if ('errors' in value) {
        const errors = attempt(() => Reflect.get(value, 'errors') as unknown);
        if (Array.isArray(errors)) fields['aggregateErrors'] = visit(errors);
        else if (errors === UNSERIALIZABLE) fields['aggregateErrors'] = UNSERIALIZABLE;
      }
      if (Object.hasOwn(value, 'cause')) fields['cause'] = field('cause');
      return fields;
    }
    // URLs expose credentials through their built-in toJSON; only copy enumerable fields.
    const toJSON: unknown = value instanceof URL ? undefined : Reflect.get(value, 'toJSON');
    if (typeof toJSON === 'function') return visit(toJSON.call(value));
    if (
      isStringObject(value) ||
      isNumberObject(value) ||
      isBooleanObject(value) ||
      isBigIntObject(value)
    ) {
      return visit(value.valueOf());
    }
    if (typeof value === 'function') return undefined;
    if (Array.isArray(value)) {
      return Array.from({ length: value.length }, (_, index) => field(String(index)));
    }
    if (value instanceof Map || value instanceof Set) return {};
    return Object.fromEntries(Object.keys(value).map((name) => [name, field(name)]));
  } catch {
    return UNSERIALIZABLE;
  } finally {
    // Only ancestors count as circular: shared values in separate branches remain visible.
    ancestors.delete(value);
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
    const toJSON: unknown = value instanceof URL ? undefined : Reflect.get(value, 'toJSON');
    const record: unknown = typeof toJSON === 'function' ? toJSON.call(value) : value;
    // A log record/binding contributes fields, not a primitive message. In particular, do
    // not split a string result into indexed characters that bypass free-text redaction.
    if (record === null || typeof record !== 'object') return {};
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
                new Set([value, record]),
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
