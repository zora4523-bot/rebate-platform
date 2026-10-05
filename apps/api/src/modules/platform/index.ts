// Public surface of the platform module. Other modules import only from this file.
export * from './clock/index.ts';
export * from './config/index.ts';
export * from './logging/index.ts';
export * from './tracing/index.ts';
export * from './idempotency/index.ts';
export * from './http/index.ts';
export { FieldCryptoError, FIELD_CRYPTO_MESSAGES } from './crypto/index.ts';
export type { FieldCrypto, FieldCryptoErrorCode } from './crypto/index.ts';
export { contractRouteSchema } from './validation/contract-routes.ts';
export type { ContractOperationId } from './validation/contract-routes.ts';
export { fieldsErrorEnvelope } from './validation/index.ts';
export { HTTP_ENTRIES, WORKER_ENTRIES, isHttpEntry } from './entries.ts';
export type { EntryName, HttpEntry, WorkerEntry } from './entries.ts';
export {
  APP_CONFIG,
  APP_ENTRY,
  DB,
  DB_READ,
  IDEMPOTENCY,
  FIELD_CRYPTO,
  JOB_QUEUE,
  EVENT_BUS,
  PlatformModule,
  ROOT_LOGGER,
} from './platform.module.ts';
export type { PlatformOptions } from './platform.module.ts';
export { EventError, EVENT_NAMES, registerEventConsumer } from './events/index.ts';
// UUIDv7 of ADR-0001 §4.2 #1 (entity ids), the generator of event ids under a neutral name.
export { newEventId as newUuidV7 } from './events/index.ts';
export type {
  EventBus,
  DomainEvent,
  PublishResult,
  ReceivedEvent,
  EventHandler,
  EventSubscription,
} from './events/index.ts';
export { createDbHandles, loadConnectionConfig, DbError } from './db/index.ts';
export type { ConnectionConfig, DbHandles } from './db/index.ts';
export { loadMaintConnectionConfig, createMaintDbHandle } from './db/maint.ts';
export type { MaintConnectionConfig, MaintDbHandle } from './db/maint.ts';
export { createWorkerMaintenance, startWorkerServices } from './maintenance/worker.ts';
export type {
  JobQueue,
  JobPayload,
  SendOptions,
  ReceivedJob,
  JobHandler,
  QueueRuntime,
} from './queue/index.ts';
