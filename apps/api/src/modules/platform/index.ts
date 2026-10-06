// Public surface of the platform module. Other modules import only from this file.
export * from './clock/index.ts';
export * from './config/index.ts';
export * from './logging/index.ts';
export * from './tracing/index.ts';
export * from './idempotency/index.ts';
export * from './http/index.ts';
// The pre-parsing registration point of the request checks (BR-ID-01 stages ①–③; bootstrap).
export { installRequestChecks, REQUEST_CHECKS, RequestRejection } from './http/request-checks.ts';
export type {
  CheckedRequest,
  RequestCheck,
  RequestCheckInput,
  VerifiedDevice,
} from './http/request-checks.ts';
export { AUDIT_PORT } from './audit/index.ts';
export type { AuditInput, AuditPort } from './audit/index.ts';
export { FieldCryptoError, FIELD_CRYPTO_MESSAGES } from './crypto/index.ts';
export type { FieldCrypto, FieldCryptoErrorCode } from './crypto/index.ts';
export { contractRouteSchema } from './validation/contract-routes.ts';
export type { ContractOperationId } from './validation/contract-routes.ts';
export { fieldsErrorEnvelope } from './validation/index.ts';
// Generated x-signed table of every contract operation (BR-ID-09; no openapi at run time).
export { contractSigningRoutes, isContractSignedRoute } from './validation/signing-routes.ts';
export type { SigningRoute } from './validation/signing-routes.ts';
// Generated snapshots of specs/link-patterns.yaml and specs/material-channels.yaml (no YAML at run time).
export { LINK_PATTERNS } from './specs/link-patterns.gen.ts';
export { getLinkPatterns } from './specs/link-patterns.ts';
export type { LinkPatternsSpec } from './specs/link-patterns.ts';
export { MATERIAL_CHANNELS } from './specs/material-channels.gen.ts';
export { getMaterialChannels } from './specs/material-channels.ts';
export type { MaterialChannelsSpec } from './specs/material-channels.ts';
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
  REDIS,
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
// Inject `REDIS` (api / stream / admin / worker; payout has none) and take a namespace per module.
export { RedisClosedError, RedisUnavailableError, RedisValidationError } from './redis/index.ts';
export type {
  RedisHandle,
  RedisNamespace,
  RedisScriptOptions,
  RedisUnavailableReason,
} from './redis/index.ts';
export type {
  JobQueue,
  JobPayload,
  SendOptions,
  ReceivedJob,
  JobHandler,
  QueueRuntime,
} from './queue/index.ts';
