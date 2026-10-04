// Shared helpers of the platform/events rule tests (规划/02 §11, §18; ADR-0001 §3, §4.2 第 1、10、16 项;
// contract in apps/api/src/modules/platform/events/index.ts). Expected values are written out by hand
// from the contract, never taken from the implementation. Nothing here imports the test-database base
// (`@couli/db/testing`): only *.int.test.ts may.
import {
  EventError,
  type EventErrorCode,
  type EventSubscription,
} from '../../../../apps/api/src/modules/platform/events/index.ts';
import type {
  EntryPlan,
  QueueSpec,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { TEST_DEAD, spec } from '../queue/kit.ts';

/** Fixed messages of contract section 9, copied by hand. */
export const EVENT_MESSAGES: Readonly<Record<EventErrorCode, string>> = {
  invalid_option: 'invalid event bus option',
  invalid_subscriptions: 'the event subscriptions are invalid',
  invalid_transaction: 'an event must be published inside a business transaction',
  invalid_event: 'invalid domain event',
  invalid_app_id: 'invalid app id of the event',
  unknown_event: 'the event name is not in the event list',
  invalid_version: 'the event version must be an integer from 1 to 999',
  invalid_event_id: 'the event id must be a lower-case canonical UUID',
  invalid_payload: 'the event payload must be a small JSON object of ids',
  personal_data: 'the event payload must not carry personal data',
  payload_too_large: 'the event payload exceeds 4096 bytes',
  event_conflict: 'an event with this id was published with other content',
  unknown_consumer: 'the consumer has no subscription',
};

/** The event list of 规划/02 §11, in order, copied by hand. */
export const PLAN_02_EVENTS = [
  'order.created',
  'order.updated',
  'order.credited',
  'order.invalidated',
  'order.clawed_back',
  'order.settle_adjusted',
  'claim.resolved',
  'binding.changed',
  'member.registered',
  'member.bound_parent',
  'member.level_changed',
  'wallet.withdrawal_changed',
  'withdrawal.created',
  'account.went_negative',
  'settle.batch_done',
  'risk.state_changed',
  'appeal.resolved',
  'agent.run_finished',
] as const;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Milliseconds encoded in the first 48 bits of a UUIDv7. */
export function uuidMs(id: string): number {
  return Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}

/**
 * Test routing table: alpha gets order.created and order.updated, beta gets order.created and
 * member.registered; nobody gets order.credited.
 */
export const SUBS: readonly EventSubscription[] = [
  { consumer: 'alpha', events: ['order.created', 'order.updated'] },
  { consumer: 'beta', events: ['order.created', 'member.registered'] },
];

/** Queues of the test routing table: standard, 2 retries of 1 s, dead letter test-dead. */
export const EVT_CATALOG: readonly QueueSpec[] = [spec('evt.alpha'), spec('evt.beta'), TEST_DEAD];

export const EVT_PLAN: EntryPlan = {
  api: [],
  stream: [],
  admin: [],
  worker: [
    { queue: 'evt.alpha', concurrency: 1, pollingIntervalSeconds: 0.5 },
    { queue: 'evt.beta', concurrency: 1, pollingIntervalSeconds: 0.5 },
  ],
  payout: [],
};

export function describeError(error: unknown): string {
  if (error instanceof EventError) return `EventError ${error.code}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `thrown ${String(error)}`;
}

/** One V8 stack frame: `    at [async ][function (]location[)]`. */
const FRAME =
  /^ {4}at (?:async )?(?:.+ \()?(?:file:\/\/\S+:\d+:\d+|node:\S+:\d+:\d+|\/\S+:\d+:\d+|<anonymous>|native|index \d+)\)?$/;

/**
 * Why `error` is not exactly an EventError of `code` (contract section 9): name, code, fixed
 * message, a stack of that message and plain frames, own properties exactly code / message / name /
 * stack, no cause.
 */
export function eventErrorProblems(error: unknown, code: EventErrorCode): string[] {
  if (!(error instanceof EventError)) return [`not an EventError: ${describeError(error)}`];
  const found: string[] = [];
  const message = EVENT_MESSAGES[code];
  if (error.name !== 'EventError') found.push('name');
  if (error.code !== code) found.push(`code ${String(error.code)}`);
  if (error.message !== message) found.push('message');
  const [first, ...frames] = (error.stack ?? '').split('\n');
  if (first !== `EventError: ${message}`) found.push('stack head');
  if (frames.length === 0 || frames.some((frame) => !FRAME.test(frame))) found.push('stack frames');
  const own = Reflect.ownKeys(error).map(String).sort();
  if (JSON.stringify(own) !== JSON.stringify(['code', 'message', 'name', 'stack'])) {
    found.push(`own properties ${own.join(',')}`);
  }
  if ('cause' in error) found.push('cause');
  return found;
}

/** The error a synchronous call threw, checked with eventErrorProblems; ['returned'] otherwise. */
export function thrownProblems(run: () => unknown, code: EventErrorCode): string[] {
  try {
    run();
  } catch (error) {
    return eventErrorProblems(error, code);
  }
  return ['returned'];
}

/** The rejection of `promise` checked with eventErrorProblems; ['resolved'] when it resolved. */
export async function rejectionProblems(
  promise: Promise<unknown>,
  code: EventErrorCode,
): Promise<string[]> {
  try {
    await promise;
  } catch (error) {
    return eventErrorProblems(error, code);
  }
  return ['resolved'];
}

/** How a promise settled: `resolved`, or describeError of the reason. */
export async function settled(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return describeError(error);
  }
  return 'resolved';
}

/** A stand-in object that records every property read (and any other trap) as `trap:key`. */
export function recordingProxy(
  base: Record<string, unknown>,
  log: string[],
): Record<string, unknown> {
  return new Proxy(base, {
    get(target, key, receiver) {
      log.push(`get:${String(key)}`);
      return Reflect.get(target, key, receiver) as unknown;
    },
    has(target, key) {
      log.push(`has:${String(key)}`);
      return Reflect.has(target, key);
    },
    set(target, key, value, receiver) {
      log.push(`set:${String(key)}`);
      return Reflect.set(target, key, value, receiver);
    },
    ownKeys(target) {
      log.push('ownKeys');
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      log.push(`descriptor:${String(key)}`);
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    apply() {
      log.push('apply');
      return undefined;
    },
  });
}

/** A fake transaction: `isTransaction` true, every access recorded. */
export function fakeTrx(log: string[]): Record<string, unknown> {
  return recordingProxy({ isTransaction: true }, log);
}

/** A fake JobQueue that records its sends and resolves the id it was given. */
export function fakeQueue(): {
  queue: { send: (...args: unknown[]) => Promise<string | null> };
  sends: unknown[][];
} {
  const sends: unknown[][] = [];
  return {
    sends,
    queue: {
      send: async (...args: unknown[]) => {
        sends.push(args);
        return null;
      },
    },
  };
}

/** A clock that returns `value` and counts its reads. */
export function countingClock(value: unknown): { clock: { now: () => Date }; reads: () => number } {
  let reads = 0;
  return {
    reads: () => reads,
    clock: {
      now: () => {
        reads += 1;
        return value as Date;
      },
    },
  };
}

/** A string of exactly `length` UTF-16 code units. */
export function text(length: number, unit = 'a'): string {
  return unit.repeat(length);
}

/**
 * A payload whose JSON.stringify is exactly `bytes` UTF-8 bytes (bytes ≥ 40), built from keys
 * k000… with string values of at most 128 code units mixing 1- and 3-byte characters.
 */
export function payloadOfBytes(bytes: number): Record<string, string> {
  const payload: Record<string, string> = {};
  const size = (): number => Buffer.byteLength(JSON.stringify(payload), 'utf8');
  let index = 0;
  // Fill with 40 × '凑' (120 bytes) entries while far from the target.
  while (size() + 300 < bytes) {
    payload[`k${String(index).padStart(3, '0')}`] = '凑'.repeat(40);
    index += 1;
  }
  const key = `k${String(index).padStart(3, '0')}`;
  payload[key] = '';
  const rest = bytes - size();
  // Use 3-byte characters for most of the rest, then 1-byte characters for the remainder.
  const threes = Math.floor(rest / 3);
  payload[key] = '凑'.repeat(threes) + 'a'.repeat(rest - threes * 3);
  if (size() !== bytes || payload[key].length > 128) {
    throw new Error(`payloadOfBytes(${bytes}) built ${size()} bytes`);
  }
  return payload;
}
