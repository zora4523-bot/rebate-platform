// B2-04m: settlement's BeneficiaryGate port (S2 option A, D10-93). The credit transaction locks the
// beneficiaries' users rows and re-reads their state only through this port; the implementation
// uses identity's and risk's exported ports only (lockUsersForUpdate, the deletion-status and
// realname-status batch readers, the risk-state batch reader) and never SELECTs users itself.
//
// BR-FUND-16 细则「加锁流程」step 2 and 4; BR-CALC-13 (deleted / banned / minor → forfeited,
// frozen / appealing → held). Skeleton: every function throws NotImplemented until implemented.
import type { DB } from '@couli/db';
import type { CreditBeneficiaryState } from '@couli/domain';
import type { Transaction } from 'kysely';
import type {
  LockUsersInput,
  RealnameStatusBatchReader,
  UserDeletionStatusReader,
} from '../../identity/index.ts';
import type { Clock } from '../../platform/index.ts';
import type { RiskStateBatchReader } from '../../risk/index.ts';

export interface BeneficiarySelection {
  readonly appId: string;
  readonly userIds: readonly string[];
}

export interface BeneficiaryGate {
  /**
   * Step 2 of the lock flow: the users rows of every given beneficiary, in ascending user_id order,
   * on the caller's transaction (identity lockUsersForUpdate). Returns the ids that were locked.
   */
  lockUsers(trx: Transaction<DB>, input: BeneficiarySelection): Promise<ReadonlySet<string>>;
  /**
   * Step 4: each beneficiary's state re-read on the caller's transaction after the locks were
   * taken (deletion status, risk state, identified as under 18). Users that are not in app.users
   * for this app are absent from the map.
   */
  readStates(
    trx: Transaction<DB>,
    input: BeneficiarySelection,
  ): Promise<ReadonlyMap<string, CreditBeneficiaryState>>;
}

export interface MinorSelection extends BeneficiarySelection {
  /** The instant of the check, from the gate's Clock. */
  readonly at: Date;
}

/**
 * Users identified as under 18 at `at` (BR-ID-26; birth date of a verified realname). No exported
 * identity port answers this yet: assembly supplies it (待编排裁定, B2-04zb).
 */
export interface MinorStatusReader {
  read(trx: Transaction<DB>, input: MinorSelection): Promise<ReadonlySet<string>>;
}

export interface BeneficiaryGateOptions {
  readonly clock: Clock;
  /** identity lockUsersForUpdate. */
  lockUsers(trx: Transaction<DB>, input: LockUsersInput): Promise<ReadonlySet<string>>;
  /** identity createUserDeletionStatusReader: none → null, processing, done. */
  readonly deletionStatus: UserDeletionStatusReader;
  /** identity createRealnameStatusBatchReader: only a verified realname can identify a minor. */
  readonly realnameStatus: RealnameStatusBatchReader;
  /** risk createRiskStateBatchReader. */
  readonly riskState: RiskStateBatchReader;
  readonly minors: MinorStatusReader;
}

export function createBeneficiaryGate(options: BeneficiaryGateOptions): BeneficiaryGate {
  void options;
  throw new Error('NotImplemented: createBeneficiaryGate');
}
