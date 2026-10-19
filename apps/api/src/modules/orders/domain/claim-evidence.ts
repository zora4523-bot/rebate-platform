import type {
  ClaimEvidenceLog,
  ClaimEvidenceBinding,
  ClaimEvidenceConflict,
} from '../../linking/index.ts';

export type ClaimEvidenceLevel = 'strong' | 'weak' | 'none';
export interface ClaimEvidenceInput {
  readonly appId: string;
  readonly userId: string;
  readonly platform: string;
  readonly attrAt: Date;
  /** Already resolved from the order column or the product-key port. */
  readonly productKey: string | null;
  readonly shopId: string | null;
  readonly windowHours: number;
  readonly logs: readonly ClaimEvidenceLog[];
  readonly bindings: readonly ClaimEvidenceBinding[];
  readonly conflicts: readonly ClaimEvidenceConflict[];
}
export interface ClaimItemEvidence {
  readonly evidence: ClaimEvidenceLevel;
  readonly evidence_link_log_ids: readonly bigint[];
}
export function judgeClaimEvidence(input: ClaimEvidenceInput): ClaimItemEvidence {
  void input;
  throw new Error('NotImplemented: judgeClaimEvidence');
}
