import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Clock } from '../clock/clock.ts';
import type { RootLogger } from '../logging/logger.ts';
import type { JobPayload, JobQueue, QueueSpec } from '../queue/types.ts';

/** Upper bound of UTF-8 bytes of JSON.stringify(payload) (section 2). */
export const MAX_EVENT_PAYLOAD_BYTES = 4_096;
/** Upper bound of UTF-16 code units of a string value of a payload (section 2). */
export const MAX_EVENT_STRING_LENGTH = 128;
/** Most levels of nesting of a payload, the payload itself being level 1 (section 2). */
export const MAX_EVENT_PAYLOAD_DEPTH = 3;
/** Version range (section 2). */
export const MAX_EVENT_VERSION = 999;

/** Event names of 规划/02 §11 (section 1). */
export const EVENT_NAMES: readonly string[] = Object.freeze([
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
]);

export interface EventSubscription {
  readonly consumer: string;
  readonly events: readonly string[];
}

/** Production routing table (section 6): empty until the first consumer arrives. */
export const EVENT_SUBSCRIPTIONS: readonly EventSubscription[] = Object.freeze([]);

export interface DomainEvent {
  readonly appId: string;
  readonly name: string;
  readonly payload: JobPayload;
  readonly version?: number;
  readonly eventId?: string;
}

export interface PublishResult {
  readonly eventId: string;
  readonly duplicate: boolean;
}

export interface EventBus {
  publish(trx: Transaction<DB>, event: DomainEvent): Promise<PublishResult>;
}

export interface EventBusOptions {
  readonly queue: JobQueue;
  readonly clock: Clock;
  readonly subscriptions?: readonly EventSubscription[];
  readonly catalog?: readonly QueueSpec[];
}

export interface ReceivedEvent {
  readonly eventId: string;
  readonly appId: string;
  readonly name: string;
  readonly version: number;
  readonly occurredAt: string;
  readonly payload: JobPayload;
  readonly consumer: string;
  readonly attempt: number;
}

export type EventHandler = (event: ReceivedEvent, trx: Transaction<DB>) => Promise<void>;

export interface EventConsumerOptions {
  readonly consumer: string;
  readonly db: Kysely<DB>;
  readonly logger: RootLogger;
  readonly handler: EventHandler;
  readonly subscriptions?: readonly EventSubscription[];
}

export type EventErrorCode =
  | 'invalid_option'
  | 'invalid_subscriptions'
  | 'invalid_transaction'
  | 'invalid_event'
  | 'invalid_app_id'
  | 'unknown_event'
  | 'invalid_version'
  | 'invalid_event_id'
  | 'invalid_payload'
  | 'personal_data'
  | 'payload_too_large'
  | 'event_conflict'
  | 'unknown_consumer';

/** The fixed message of each code (section 9). */
export const EVENT_ERROR_MESSAGES: Readonly<Record<EventErrorCode, string>> = Object.freeze({
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
});

export class EventError extends Error {
  readonly code: EventErrorCode;

  constructor(code: EventErrorCode) {
    super(EVENT_ERROR_MESSAGES[code]);
    this.code = code;
    this.name = 'EventError';
  }
}
