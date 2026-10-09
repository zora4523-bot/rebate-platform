export type AdminStepUpTier = 'totp' | 'sms';

export interface AdminPermissionDefinition {
  readonly key: string;
  readonly step_up_tier: AdminStepUpTier | null;
  readonly operations: readonly { readonly operation: string; readonly tier: AdminStepUpTier }[];
}

/** Runtime view of the generated permissions snapshot; never parses YAML at runtime. */
export function getAdminPermissionCatalog(): readonly AdminPermissionDefinition[] {
  throw new Error('NotImplemented: getAdminPermissionCatalog');
}
