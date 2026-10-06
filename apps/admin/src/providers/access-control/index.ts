import type { AdminPermission } from '@couli/contracts-ts';

export interface PermissionSnapshot {
  readonly isSuper: boolean;
  readonly permissions: readonly string[];
}

export type PermissionsProvider = () => Promise<PermissionSnapshot>;

export interface AccessControl {
  can(permission: AdminPermission): boolean;
}

export function createAccessControl(snapshot: PermissionSnapshot): AccessControl {
  void snapshot;
  throw new Error('NotImplemented: createAccessControl');
}
