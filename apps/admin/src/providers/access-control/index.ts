import type { AdminPermission, Schema } from '@couli/contracts-ts';

export type KnownPermission = AdminPermission;
export type StepUpTier = Schema<'AdminStepUpTier'>;

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
  stepUpTier(permission: string, operation?: string): StepUpTier | null;
}

export function isKnownPermission(value: string): value is KnownPermission {
  void value;
  throw new Error('NotImplemented: isKnownPermission');
}

export function permissionsFromMe(meResponseData: Schema<'AdminMe'>): PermissionSnapshot {
  void meResponseData;
  throw new Error('NotImplemented: permissionsFromMe');
}

export function createAccessControl(snapshot: PermissionSnapshot): AccessControl {
  void snapshot;
  throw new Error('NotImplemented: createAccessControl');
}
