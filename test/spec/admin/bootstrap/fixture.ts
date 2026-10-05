import { randomBytes, scryptSync } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import {
  createAdminBootstrap,
  type BootstrapDeps,
  type BootstrapRequest,
} from '../../../../apps/api/src/modules/admin/application/bootstrap.ts';
import { createAuditWriter } from '../../../../apps/api/src/modules/admin/infra/audit-writer.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  LocalKeyProvider,
  createWrappedKeyring,
  openFieldCrypto,
} from '../../../../apps/api/src/modules/platform/crypto/index.ts';

// RFC 6238 Appendix B 公开测试种子（ASCII "12345678901234567890"），非密钥；运行时按 RFC 4648 编成 Base32。
export const SECRET = rfc4648Base32(Buffer.from('12345678901234567890', 'ascii'));
function rfc4648Base32(bytes: Buffer): string {
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  return (bits.match(/.{1,5}/g) ?? [])
    .map((g) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[parseInt(g.padEnd(5, '0'), 2)])
    .join('');
}
export const PASSWORD = 'F1-06c fixture password / never deployed';
export const ACTIVE = 'f1-06c-fixture-enabled';
export const ADMIN_ID = '019a0000-0000-7000-8000-00000000006c';
export const REQUEST: BootstrapRequest = { appId: 'couli', loginName: 'bootstrap-owner' };

/** No Vitest import: the concurrency child uses the same public entry via plain Node. */
export async function fixture(db: Kysely<DB>) {
  const clock = new FixedClock('1970-01-01T00:00:59Z');
  const provider = new LocalKeyProvider(randomBytes(32));
  const crypto = await openFieldCrypto(await createWrappedKeyring(provider), provider);
  const bindings: string[] = [];
  const messages: string[] = [];
  const logs: unknown[] = [];
  const passwords: string[] = [];
  let secretGenerations = 0;
  let passwordReads = 0;
  let codeReads = 0;
  const salt = randomBytes(16);
  const expectedHash = `fixture-scrypt:${salt.toString('hex')}:${scryptSync(PASSWORD, salt, 32).toString('hex')}`;
  const log = (fields: Readonly<Record<string, unknown>>, message: string) => {
    logs.push({ fields, message });
  };
  const deps: BootstrapDeps = {
    db,
    clock,
    crypto,
    activeStatus: ACTIVE,
    issuer: 'Couli rule fixture',
    generateTotpSecret: () => {
      secretGenerations += 1;
      return Buffer.from('12345678901234567890', 'ascii');
    },
    newAdminId: () => ADMIN_ID,
    hashPassword: async (password) => {
      passwords.push(password);
      return `fixture-scrypt:${salt.toString('hex')}:${scryptSync(password, salt, 32).toString('hex')}`;
    },
    audit: (transaction) => createAuditWriter({ db: transaction, clock }),
    terminal: {
      isTTY: true,
      readPassword: async () => {
        passwordReads += 1;
        return PASSWORD;
      },
      readCode: async () => {
        codeReads += 1;
        // RFC 6238 t=59s, eight-digit SHA-1 value 94287082 reduced to six digits.
        return '287082';
      },
      showBinding: (uri) => bindings.push(uri),
      write: (message) => messages.push(message),
    },
    logger: { info: log, warn: log, error: log },
  };
  return {
    deps,
    clock,
    crypto,
    bindings,
    messages,
    logs,
    passwords,
    secretGenerations: () => secretGenerations,
    expectedHash,
    reads: () => ({ password: passwordReads, code: codeReads }),
    // Always construct outside rejection assertions: NotImplemented must make EVERY test red.
    create: (patch: Partial<BootstrapDeps> = {}) => createAdminBootstrap({ ...deps, ...patch }),
  };
}

export async function snapshot(db: Kysely<DB>) {
  return {
    users: await db.selectFrom('admin_users').selectAll().orderBy('id').execute(),
    permissions: await db.selectFrom('admin_permissions').selectAll().orderBy('id').execute(),
    audits: await db.selectFrom('audit_logs').selectAll().orderBy('id').execute(),
  };
}

export function printable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item,
  );
}
