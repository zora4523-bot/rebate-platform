// The register-time level log (B1-11b; BR-INV-14 source=register, effective_at = created_at):
// adapts identity's own InitialLevelLog port (wired from app.module; identity never imports
// growth) to RegistrationOptions.recordInitialLevel. In the registration transaction it reads the
// new account's users.created_at and appends from_level null → to_level = input.level with that
// instant; no users row → throws (the whole creation rolls back, 50001).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { UserLevel } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { RegistrationOptions } from './registration.ts';

export interface InitialLevelLogEntry {
  readonly app_id: string;
  readonly user_id: string;
  readonly to_level: UserLevel;
  readonly effective_at: Date;
}

export interface InitialLevelLog {
  append(trx: Transaction<DB>, entry: InitialLevelLogEntry): Promise<void>;
}

export type RecordInitialLevel = NonNullable<RegistrationOptions['recordInitialLevel']>;

export function createRecordInitialLevel(log: InitialLevelLog): RecordInitialLevel {
  void log;
  throw new Error('NotImplemented: createRecordInitialLevel');
}
