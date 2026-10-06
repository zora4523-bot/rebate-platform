// Refine access control for the admin shell. Navigation actions follow menu visibility; business
// actions name a permission key and need that exact key (and a visible menu when a resource is
// given); any other action is denied. The server checks every action again.
import type { AccessControlProvider, CanParams, CanReturnType } from '@refinedev/core';
import type { AdminMenuGroup } from '../../resources/index.ts';
import { isKnownPermission, type AccessControl } from './index.ts';

/** Refine actions that only open a menu's pages. */
export const NAVIGATION_ACTIONS: ReadonlySet<string> = new Set(['list', 'show']);

const DENIED_UNCONFIGURED: CanReturnType = { can: false, reason: 'unconfigured action' };
const DENIED_LOADING: CanReturnType = { can: false, reason: 'permissions not loaded' };

/**
 * `access` is undefined while permissions load (everything is denied); `groups` are the menus
 * visible to the same account (selectAdminMenuGroups).
 */
export function decideAccess(
  access: AccessControl | undefined,
  groups: readonly AdminMenuGroup[],
  { resource, action }: Pick<CanParams, 'resource' | 'action'>,
): CanReturnType {
  if (access === undefined) return DENIED_LOADING;
  const visible = new Set<string>(
    groups.flatMap((group) => [group.key, ...group.items.map((item) => item.id)]),
  );
  const menuVisible = resource !== undefined && visible.has(resource);
  if (NAVIGATION_ACTIONS.has(action)) return { can: menuVisible };
  if (isKnownPermission(action)) {
    return { can: access.can(action) && (resource === undefined || menuVisible) };
  }
  return DENIED_UNCONFIGURED;
}

export function createRefineAccessControl(
  access: AccessControl | undefined,
  groups: readonly AdminMenuGroup[],
): AccessControlProvider {
  return { can: (params) => Promise.resolve(decideAccess(access, groups, params)) };
}
