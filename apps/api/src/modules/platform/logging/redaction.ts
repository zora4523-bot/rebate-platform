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
const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const digit = '[0-9０-９]';
const id18 = `${digit}(?:[ -]?${digit}){16}[ -]?[0-9０-９Xx]`;
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

/** Copy before serialization, including toJSON results and errors, without mutating callers. */
export function redactValue(value: unknown, key = '', ancestors = new Set<object>()): unknown {
  if (sensitiveNames.has(normalizedKey(key))) return REDACTED;
  if (freeTextKeys.has(key) && (typeof value === 'string' || typeof value === 'number')) {
    return redactText(String(value));
  }
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.has(value)) return '[Circular]';
  ancestors.add(value);
  try {
    if (value instanceof Error) {
      const fields: Record<string, unknown> = {
        type: value.constructor.name,
        message: value.message,
        stack: value.stack,
        ...Object.fromEntries(Object.entries(value)),
      };
      if ('errors' in value && Array.isArray(value.errors))
        fields['aggregateErrors'] = value.errors;
      if (Object.hasOwn(value, 'cause')) fields['cause'] = value.cause;
      return redactFields(fields, ancestors);
    }
    if ('toJSON' in value && typeof value.toJSON === 'function') {
      return redactValue(value.toJSON(), key, ancestors);
    }
    if (Array.isArray(value)) return value.map((item) => redactValue(item, '', ancestors));
    if (value instanceof Map || value instanceof Set) return {};
    return redactFields(value, ancestors);
  } finally {
    // Only ancestors count as circular: shared values in separate branches remain visible.
    ancestors.delete(value);
  }
}

function redactFields(value: object, ancestors: Set<object>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactValue(item, key, ancestors)]),
  );
}

export function redactRecord(value: object): Record<string, unknown> {
  return redactValue(value) as Record<string, unknown>;
}
