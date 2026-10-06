import type { AdminPermission } from '@couli/contracts-ts';
import type { PermissionSnapshot } from '../providers/access-control/index.ts';

export type MenuAccess =
  | { readonly kind: 'authenticated' }
  | { readonly kind: 'super' }
  | { readonly kind: 'any'; readonly permissions: readonly AdminPermission[] };

export interface AdminMenuItem {
  readonly id: string;
  readonly label: string;
  readonly access: MenuAccess;
}

export interface AdminMenuGroup {
  readonly label: string;
  readonly items: readonly AdminMenuItem[];
}

export function getAdminMenuGroups(): readonly AdminMenuGroup[] {
  throw new Error('NotImplemented: getAdminMenuGroups');
}

export function selectAdminMenuGroups(snapshot: PermissionSnapshot): readonly AdminMenuGroup[] {
  void snapshot;
  throw new Error('NotImplemented: selectAdminMenuGroups');
}
