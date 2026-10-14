// The admin permission points and their step-up tiers (F1-06l; 04 §11 step-up column; 08 BR-ID-34
// 「后台 step-up 分两档」). The table is specs/permissions.yaml, snapshotted at build time into
// ./permissions.gen.ts (admin/scripts/generate-permissions.ts); nothing parses YAML at run time.
// Its keys are exactly contracts/enums/admin.yaml `admin_permission`, in enum order
// (permission-catalog.test.ts).
//
// Pure module (no decorators, erasable syntax).
import { ADMIN_PERMISSIONS } from './permissions.gen.ts';

export type AdminStepUpTier = 'totp' | 'sms';

export interface AdminPermissionDefinition {
  readonly key: string;
  readonly step_up_tier: AdminStepUpTier | null;
  readonly operations: readonly { readonly operation: string; readonly tier: AdminStepUpTier }[];
}

const CATALOG: readonly AdminPermissionDefinition[] = ADMIN_PERMISSIONS.permissions;
const BY_KEY: ReadonlyMap<string, AdminPermissionDefinition> = new Map(
  CATALOG.map((entry) => [entry.key, entry]),
);

/** Runtime view of the generated permissions snapshot; never parses YAML at runtime. */
export function getAdminPermissionCatalog(): readonly AdminPermissionDefinition[] {
  return CATALOG;
}

/**
 * The tier an operation under `permission` needs: the operation's own tier where the table lists
 * one, else the permission's (null = no step-up). A key outside the catalog is a programming
 * error of the calling route, never a pass.
 */
export function requiredStepUpTier(permission: string, operation?: string): AdminStepUpTier | null {
  const entry = BY_KEY.get(permission);
  if (entry === undefined) throw new Error(`admin: unknown permission point ${permission}`);
  if (operation !== undefined) {
    const special = entry.operations.find((item) => item.operation === operation);
    if (special !== undefined) return special.tier;
  }
  return entry.step_up_tier;
}

/**
 * The account's permission points in catalog (enum) order: every point for a super admin, the
 * ticked points otherwise; a ticked key outside the catalog is ignored.
 */
export function grantedPermissions(
  isSuper: boolean,
  ticked: Iterable<string>,
): readonly AdminPermissionDefinition[] {
  if (isSuper) return CATALOG;
  const wanted = new Set(ticked);
  return CATALOG.filter((entry) => wanted.has(entry.key));
}
