// B2-03g: in-memory SnapshotBeneficiaryResolver for tests only; the real one is
// beneficiary-resolver.ts (B2-03p). It answers from a fixed table keyed by (appId, ownerUserId) and
// never touches the database. Unknown owner → throws (no default relation or level is invented).
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
