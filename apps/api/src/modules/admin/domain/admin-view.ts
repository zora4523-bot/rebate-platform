// Read-only view of an admin account (F1-06m; contract AdminAccount; 04 §6.6 admins, §11; 08
// BR-ID-33). Pure functions: no Nest, no data access, time only from the caller (the Clock).
//   - verify phone: masked by ./step-up-policy.ts maskVerifyPhone (BR-ID-33, shared with
//     me/permissions);
//   - permissions: a super admin has every point, shown as []; another account shows its ticked
//     points that are still in the admin_permission enum, in the enum's order, once each;
//   - locked_until: only a lock still in force by the Clock; an ended lock is null;
//   - admin_id: a well-formed UUID string, else the account is unknown (20001 fields=[admin_id]).
import { admin_permission, type AdminPermission } from '@couli/contracts-ts';
import { isLocked } from './login-policy.ts';

/** Admin page size bounds and defaults (04 §5 后台分页; contract AdminPage / AdminPageSize). */
export const ADMIN_PAGE_DEFAULT = 1;
export const ADMIN_PAGE_SIZE_DEFAULT = 20;
export const ADMIN_PAGE_SIZE_MAX = 200;

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** True for a string PG accepts as a uuid in its canonical hyphenated form. */
export function isAdminId(value: string): boolean {
  return UUID.test(value);
}

const ORDER: ReadonlyMap<string, number> = new Map(admin_permission.map((key, i) => [key, i]));

/** Ticked points shown for an account: [] for a super admin; else known points in enum order. */
export function visiblePermissions(isSuper: boolean, ticked: readonly string[]): AdminPermission[] {
  if (isSuper) return [];
  const known = new Set<AdminPermission>();
  for (const key of ticked) {
    if (ORDER.has(key)) known.add(key as AdminPermission);
  }
  return [...known].sort((a, b) => ORDER.get(a)! - ORDER.get(b)!);
}

/** The lock in force at `now`, else null (an ended lock is not shown). */
export function lockInForce(lockedUntil: Date | null, now: Date): Date | null {
  return isLocked(lockedUntil, now) ? lockedUntil : null;
}
