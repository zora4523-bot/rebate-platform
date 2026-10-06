// Permission snapshot of the signed-in account and the CASL ability built from it (规划/03 §9.2).
// The snapshot comes from an injected provider: /admin/v1/me/permissions is not in the contract
// yet (CT-02f), so the shell never calls it itself. The server re-checks every action.
import { admin_permission, type AdminPermission } from '@couli/contracts-ts';
import { createMongoAbility, type MongoAbility } from '@casl/ability';

export interface PermissionSnapshot {
  readonly isSuper: boolean;
  readonly permissions: readonly string[];
}

export type PermissionsProvider = () => Promise<PermissionSnapshot>;

/**
 * Permission keys that 规划/04 §11 added on 2026-10-04 (payments line) and that
 * contracts/enums/admin.yaml does not list yet. 待 CT-21a 同步后删除。
 */
// TODO(规划/11 §2.3): 契约补上这 4 个权限点后删除本常量与 PendingContractPermission — blocked on CT-21a
export const PENDING_CONTRACT_PERMISSIONS = [
  'pay.view',
  'pay.refund',
  'pay.resolve',
  'switch.pay',
] as const;

export type PendingContractPermission = (typeof PENDING_CONTRACT_PERMISSIONS)[number];
export type KnownPermission = AdminPermission | PendingContractPermission;

const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set<string>([
  ...admin_permission,
  ...PENDING_CONTRACT_PERMISSIONS,
]);

/** True for contract keys and the pending keys above; anything else grants nothing. */
export function isKnownPermission(value: string): value is KnownPermission {
  return KNOWN_PERMISSIONS.has(value);
}

type AdminAbility = MongoAbility<[KnownPermission | 'manage', 'console' | 'all']>;

export interface AccessControl {
  readonly isSuper: boolean;
  can(permission: KnownPermission): boolean;
}

/**
 * Exact-match permission checks: a super admin holds every key, other accounts only the listed
 * known keys. Unknown keys (typos, prefixes, CASL's own `manage`) grant nothing.
 */
export function createAccessControl(snapshot: PermissionSnapshot): AccessControl {
  const ability = createMongoAbility<AdminAbility>(
    snapshot.isSuper
      ? [{ action: 'manage', subject: 'all' }]
      : snapshot.permissions
          .filter(isKnownPermission)
          .map((action) => ({ action, subject: 'console' as const })),
  );
  return {
    isSuper: snapshot.isSuper,
    can: (permission) => ability.can(permission, 'console'),
  };
}
