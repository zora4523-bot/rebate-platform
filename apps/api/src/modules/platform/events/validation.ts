import { SENSITIVE_KEYS } from '../logging/redaction.ts';
import type { QueueSpec } from '../queue/types.ts';
import {
  EVENT_NAMES,
  EventError,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_EVENT_PAYLOAD_DEPTH,
  MAX_EVENT_STRING_LENGTH,
  MAX_EVENT_VERSION,
  type EventSubscription,
} from './types.ts';

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

export function plain(value: unknown): value is Record<string, unknown> {
  if (!object(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

/** Validate descriptors without invoking accessors. */
export function keys(
  value: unknown,
  allowed: readonly string[],
  required = allowed,
): value is Record<string, unknown> {
  return (
    plain(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key === 'string' &&
        allowed.includes(key) &&
        descriptor?.enumerable === true &&
        Object.hasOwn(descriptor, 'value')
      );
    })
  );
}

export function appId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value);
}

export function uuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  );
}

export function version(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_EVENT_VERSION
  );
}

export function instant(value: unknown): asserts value is Date {
  if (!(value instanceof Date)) throw new EventError('invalid_option');
  const ms = Date.prototype.getTime.call(value);
  if (!Number.isInteger(ms) || ms < 0 || ms >= 2 ** 48) {
    throw new EventError('invalid_option');
  }
}

const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Exactly the strings Date#toISOString() gives for an instant of 0..2^48−1 ms (what publish puts in
 * occurred_at): a four-digit year up to 9999, or `+` and six digits from year 10000 on.
 */
export function occurredAt(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(?:(\d{4})|\+(0\d{5}))-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{3}Z$/.exec(
    value,
  );
  if (match === null) return false;
  const [, short, long, month, day, hour, minute, second] = match.map(Number);
  const year = (match[1] === undefined ? long : short)!;
  if (match[2] !== undefined && year < 10_000) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 && leap ? 29 : daysInMonth[month! - 1];
  if (days === undefined || day! < 1 || day! > days || hour! > 23 || minute! > 59 || second! > 59) {
    return false;
  }
  const ms = Date.parse(value);
  return Number.isInteger(ms) && ms >= 0 && ms < 2 ** 48;
}

export function subscriptions(
  value: unknown,
  catalog?: readonly QueueSpec[],
): readonly EventSubscription[] {
  if (!Array.isArray(value)) throw new EventError('invalid_subscriptions');
  const consumers = new Set<string>();
  const result: EventSubscription[] = [];
  for (const item of value) {
    if (
      !keys(item, ['consumer', 'events']) ||
      typeof item.consumer !== 'string' ||
      !/^[a-z][a-z0-9-]{0,45}$/.test(item.consumer) ||
      consumers.has(item.consumer) ||
      !Array.isArray(item.events) ||
      item.events.length === 0 ||
      new Set(item.events).size !== item.events.length ||
      !Array.from(item.events).every(
        (name: unknown) => typeof name === 'string' && EVENT_NAMES.includes(name),
      ) ||
      (catalog !== undefined &&
        !catalog.some(
          (spec) => spec?.name === `evt.${item.consumer as string}` && spec.policy === 'standard',
        ))
    ) {
      throw new EventError('invalid_subscriptions');
    }
    consumers.add(item.consumer);
    result.push({ consumer: item.consumer, events: [...item.events] as string[] });
  }
  return result;
}

const personalKeys = new Set<string>(
  [...SENSITIVE_KEYS, 'email', 'name', 'nickname', 'address', 'ip', 'open_id', 'union_id'].map(
    (key) => key.replace(/[^a-z0-9]/g, ''),
  ),
);

/** Validate the complete structure before reporting personal data, regardless of key order. */
export function payload(value: unknown): string {
  let personal = false;
  const ancestors = new Set<object>();
  function json(item: unknown, level: number): boolean {
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isSafeInteger(item);
    if (typeof item === 'string')
      return (
        item.length <= MAX_EVENT_STRING_LENGTH && item.isWellFormed() && !item.includes('\u0000')
      );
    if (!object(item) || level > MAX_EVENT_PAYLOAD_DEPTH || ancestors.has(item)) return false;
    const array = Array.isArray(item);
    if (array ? Object.getPrototypeOf(item) !== Array.prototype : !plain(item)) return false;
    const ownKeys = Reflect.ownKeys(item);
    if (array && ownKeys.length !== item.length + 1) return false;
    ancestors.add(item);
    const valid = ownKeys.every((key) => {
      if (array && key === 'length') return true;
      if (typeof key !== 'string') return false;
      if (array) {
        if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length) return false;
      } else {
        if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) return false;
        personal ||= personalKeys.has(key.replace(/_/g, ''));
      }
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      return (
        descriptor?.enumerable === true &&
        Object.hasOwn(descriptor, 'value') &&
        json(descriptor.value, level + 1)
      );
    });
    ancestors.delete(item);
    return valid;
  }
  if (!plain(value) || !json(value, 1)) throw new EventError('invalid_payload');
  if (personal) throw new EventError('personal_data');
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_EVENT_PAYLOAD_BYTES) {
    throw new EventError('payload_too_large');
  }
  return serialized;
}
