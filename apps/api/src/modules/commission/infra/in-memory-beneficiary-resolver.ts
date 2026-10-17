// B2-03g: in-memory SnapshotBeneficiaryResolver for tests and for callers wiring the writer before
// the real resolver exists. It answers from a fixed table keyed by (appId, ownerUserId) and never
// touches the database. Unknown owner → throws (no default relation or level is invented).
// TODO(规划/11 §4.2): 读 level_change_logs / relation_change_logs 的真实解析器 — blocked on B1-11a
import type {
  SnapshotBeneficiaries,
  SnapshotBeneficiaryResolver,
} from '../application/snapshot.ts';

export function createInMemoryBeneficiaryResolver(
  entries: readonly { readonly appId: string; readonly beneficiaries: SnapshotBeneficiaries }[],
): SnapshotBeneficiaryResolver {
  const table = new Map<string, SnapshotBeneficiaries>();
  for (const entry of entries) {
    table.set(`${entry.appId}\u0000${entry.beneficiaries.owner.userId}`, entry.beneficiaries);
  }
  return {
    resolve(_trx, input) {
      const found = table.get(`${input.appId}\u0000${input.ownerUserId}`);
      if (found === undefined) {
        return Promise.reject(
          new Error('commission: in-memory beneficiary resolver has no entry for this owner'),
        );
      }
      return Promise.resolve(found);
    },
  };
}
