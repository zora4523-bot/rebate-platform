import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { AuditPort, Clock, FieldCrypto } from '../../platform/index.ts';

/** Terminal-only port. null means EOF/cancellation; passwords/codes must not be echoed. */
export interface BootstrapTerminal {
  readonly isTTY: boolean;
  readPassword(): Promise<string | null>;
  readCode(): Promise<string | null>;
  /** The only permitted sink for the otpauth URI, called once per binding attempt. */
  showBinding(uri: string): void;
  write(message: string): void;
}

/** The CLI wires this port to pino; credentials must never reach any log level. */
export interface BootstrapLogger {
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
  error(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface BootstrapDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly crypto: Pick<FieldCrypto, 'encrypt' | 'decrypt'>;
  /** CLI wires generateAdminTotpSecret; reject fewer than 20 bytes before disclosure. */
  readonly generateTotpSecret: () => Uint8Array;
  /** CLI supplies the domain UUIDv7 generator. */
  readonly newAdminId: () => string;
  /** CLI wires hashAdminPassword, shared with the future F1-06 login verifier. */
  readonly hashPassword: (password: string) => Promise<string>;
  /** Must bind the F1-06b audit writer to the account-creation transaction. */
  readonly audit: (transaction: Transaction<DB>) => AuditPort;
  readonly terminal: BootstrapTerminal;
  readonly logger: BootstrapLogger;
  /** Trusted configuration: schema/contracts deliberately leave admin status open. */
  readonly activeStatus: string;
  readonly issuer: string;
}

export interface BootstrapRequest {
  readonly appId: string;
  readonly loginName: string;
}

export interface BootstrapResult {
  /** 0 only after account + binding + audit commit; all refusals are nonzero. */
  readonly exitCode: number;
}

export interface AdminBootstrap {
  /**
   * No super anywhere in admin_users (including inactive/unbound/other-app supers).
   * Confirm the displayed secret using F1-06b TOTP before inserting any account/binding.
   * Account and audit commit atomically. A database lock/constraint arbitrates independent
   * processes, and the existence check must remain true at commit. No permissions or tokens.
   * Wrong code/EOF may terminate this attempt; a later attempt generates a fresh secret.
   * No filesystem writes, direct console/stdout logging, or returned credentials.
   */
  run(request: BootstrapRequest): Promise<BootstrapResult>;
}

/** Pure, directly Node-loadable entry point; no Nest or dist dependency. */
export function createAdminBootstrap(deps: BootstrapDeps): AdminBootstrap {
  void deps;
  throw new Error('NotImplemented: createAdminBootstrap');
}

/**
 * Production password format for bootstrap and future F1-06 login (technical choice;
 * neither ADR nor contracts prescribe an existing format):
 * scrypt$v=1$N=131072$r=8$p=1$<16-byte lowercase hex salt>$<64-byte lowercase hex key>.
 * Fresh cryptographic salt per call; Node scrypt maxmem must allow the chosen cost.
 * The CLI imports this function, never supplies a separate password implementation.
 */
export function hashAdminPassword(password: string): Promise<string> {
  void password;
  throw new Error('NotImplemented: hashAdminPassword');
}

/** Verify the versioned format above; wrong passwords and malformed hashes return false. */
export function verifyAdminPassword(password: string, encodedHash: string): Promise<boolean> {
  void password;
  void encodedHash;
  throw new Error('NotImplemented: verifyAdminPassword');
}

/** Production CLI generator: fresh cryptographically random bytes, at least 20 per call. */
export function generateAdminTotpSecret(): Uint8Array {
  throw new Error('NotImplemented: generateAdminTotpSecret');
}
