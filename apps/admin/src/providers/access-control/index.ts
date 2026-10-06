// Permission snapshot of the signed-in account and the CASL ability built from it (规划/03 §9.2).
// The snapshot comes from GET /admin/v1/me/permissions (permissionsFromMe) or an injected
// provider; menus and buttons are hidden by it and the server checks every action again (10403).
import { admin_permission, type AdminPermission, type Schema } from '@couli/contracts-ts';
import { createMongoAbility, type MongoAbility } from '@casl/ability';

export type KnownPermission = AdminPermission;
export type StepUpTier = Schema<'AdminStepUpTier'>;

/** Step-up annotation of one permission point: default tier plus per-operation exceptions. */
export interface StepUpAnnotation {
  readonly tier: StepUpTier | null;
  readonly operations: Readonly<Record<string, StepUpTier>>;
}

export interface PermissionSnapshot {
  readonly isSuper: boolean;
  readonly permissions: readonly string[];
  /** Optional for the existing injected shell snapshots. */
  readonly stepUp?: Readonly<Partial<Record<KnownPermission, StepUpAnnotation>>>;
}

export type PermissionsProvider = () => Promise<PermissionSnapshot>;

export interface AccessControl {
  readonly isSuper: boolean;
  can(permission: string): boolean;
  /** Tier the operation needs (exception first, else the point's default); null = none or no access. */
  stepUpTier(permission: string, operation?: string): StepUpTier | null;
}

const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set<string>(admin_permission);
const STEP_UP_TIERS: ReadonlySet<string> = new Set<StepUpTier>(['totp', 'sms']);

/** True only for contract keys (contracts/enums/admin.yaml); anything else grants nothing. */
export function isKnownPermission(value: string): value is KnownPermission {
  return KNOWN_PERMISSIONS.has(value);
}

function isStepUpTier(value: unknown): value is StepUpTier {
  return typeof value === 'string' && STEP_UP_TIERS.has(value);
}

/**
 * Converts the `data` of /admin/v1/me/permissions. Keys outside the contract (typos, wildcards,
 * future points) are dropped together with their annotations; the input is not modified.
 */
export function permissionsFromMe(meResponseData: Schema<'AdminMe'>): PermissionSnapshot {
  const permissions: KnownPermission[] = [];
  const stepUp: Partial<Record<KnownPermission, StepUpAnnotation>> = {};
  for (const grant of meResponseData.permissions) {
    const key = grant.key;
    if (!isKnownPermission(key) || permissions.includes(key)) continue;
    permissions.push(key);
    // Object.fromEntries defines own properties, so operation keys such as "__proto__" stay data.
    const operations: Record<string, StepUpTier> = Object.fromEntries(
      grant.step_up_operations
        .filter((item) => typeof item.operation === 'string' && isStepUpTier(item.tier))
        .map((item) => [item.operation, item.tier]),
    );
    stepUp[key] = {
      tier: isStepUpTier(grant.step_up_tier) ? grant.step_up_tier : null,
      operations,
    };
  }
  return { isSuper: meResponseData.is_super === true, permissions, stepUp };
}

type AdminAbility = MongoAbility<[KnownPermission | 'manage', 'console' | 'all']>;

/**
 * Exact-match permission checks: a super admin holds every contract key, other accounts only the
 * listed known keys. Unknown keys (typos, prefixes, CASL's own `manage`) grant nothing and have no
 * step-up tier. Super admins still get the step-up tiers the server annotated.
 */
export function createAccessControl(snapshot: PermissionSnapshot): AccessControl {
  const ability = createMongoAbility<AdminAbility>(
    snapshot.isSuper
      ? [{ action: 'manage', subject: 'all' }]
      : snapshot.permissions
          .filter(isKnownPermission)
          .map((action) => ({ action, subject: 'console' as const })),
  );
  const stepUp = snapshot.stepUp ?? {};
  const can = (permission: string): boolean =>
    isKnownPermission(permission) && ability.can(permission, 'console');
  return {
    isSuper: snapshot.isSuper,
    can,
    stepUpTier(permission, operation) {
      if (!can(permission) || !Object.hasOwn(stepUp, permission)) return null;
      const annotation = stepUp[permission as KnownPermission];
      if (annotation === undefined) return null;
      if (operation !== undefined && Object.hasOwn(annotation.operations, operation)) {
        return annotation.operations[operation] ?? null;
      }
      return annotation.tier;
    },
  };
}
