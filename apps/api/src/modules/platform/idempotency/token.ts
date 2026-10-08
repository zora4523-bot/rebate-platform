// The Nest injection token of the idempotency primitive, provided by platform.module.ts on entries
// with a database. Kept apart from platform.module.ts so the abandon controller, which that module
// registers, can inject it without a circular import. Plain TypeScript, no NestJS.

/** Nest injection token of `Idempotency` (re-exported by platform.module.ts). */
export const IDEMPOTENCY = Symbol('IDEMPOTENCY');
