// Sidebar catalogue: groups and menus in the fixed design order (design-hifi Adm* boards) and
// the permission keys that show each menu (sample-data.md §10.1, 规划/04 §11). Any listed key
// shows the menu; a group without visible menus is hidden; a super admin sees everything.
import {
  createAccessControl,
  type KnownPermission,
  type PermissionSnapshot,
} from '../providers/access-control/index.ts';
import { menuTexts, type MenuGroupKey, type MenuItemId } from '../texts/menu.ts';

export type MenuAccess =
  | { readonly kind: 'authenticated' }
  | { readonly kind: 'super' }
  | { readonly kind: 'any'; readonly permissions: readonly KnownPermission[] };

export interface AdminMenuItem {
  readonly id: MenuItemId;
  readonly label: string;
  readonly access: MenuAccess;
}

export interface AdminMenuGroup {
  readonly key: MenuGroupKey;
  readonly label: string;
  readonly items: readonly AdminMenuItem[];
}

const AUTHENTICATED: MenuAccess = Object.freeze({ kind: 'authenticated' });
const SUPER_ONLY: MenuAccess = Object.freeze({ kind: 'super' });
const any = (...permissions: KnownPermission[]): MenuAccess =>
  Object.freeze({ kind: 'any', permissions: Object.freeze(permissions) });

type CatalogueRow = readonly [MenuGroupKey, readonly (readonly [MenuItemId, MenuAccess])[]];

const CATALOGUE: readonly CatalogueRow[] = [
  [
    'users-orders',
    [
      ['users', any('user.list', 'user.lookup')],
      ['orders', any('order.view')],
      ['claims', any('order.claim')],
    ],
  ],
  [
    'funds',
    [
      ['withdrawals', any('withdraw.review', 'payout.execute', 'payout.manual_entry')],
      ['settle-bills', any('settle.bill', 'settle.statement_upload', 'fund.settle_adjust')],
      ['ledger', any('fund.view')],
      ['fund-ledger', any('fund.cash_entry')],
      ['recon', any('fund.recon')],
      ['adjustments', any('fund.adjust', 'fund.writeoff')],
      ['pay-orders', any('pay.view', 'pay.refund', 'pay.resolve')],
    ],
  ],
  [
    'operations',
    [
      ['pages', any('content.page')],
      ['pools', any('content.pool')],
      ['content', any('content.article', 'content.agreement')],
      ['messages', any('content.article', 'content.fund_terms')],
      ['app-versions', any('content.app_version')],
    ],
  ],
  [
    'rules-config',
    [
      ['commission-rules', any('config.business')],
      ['config', any('config.general', 'config.risk', 'config.business')],
      ['switches', any('switch.all', 'switch.payout', 'switch.pay')],
      ['unions', any('union.account_auth', 'union.pid')],
    ],
  ],
  [
    'risk-ai',
    [
      ['risk', any('risk.freeze', 'risk.ban', 'risk.blocklist', 'risk.appeal')],
      ['agent-traces', any('agent.trace', 'agent.report')],
    ],
  ],
  ['data', [['reports', AUTHENTICATED]]],
  [
    'system',
    [
      ['admins', SUPER_ONLY],
      ['audit-logs', AUTHENTICATED],
    ],
  ],
];

const MENU_GROUPS: readonly AdminMenuGroup[] = Object.freeze(
  CATALOGUE.map(([key, items]) =>
    Object.freeze({
      key,
      label: menuTexts.groups[key],
      items: Object.freeze(
        items.map(([id, access]) => Object.freeze({ id, label: menuTexts.items[id], access })),
      ),
    }),
  ),
);

/** The full catalogue, in design order (what a super admin sees). */
export function getAdminMenuGroups(): readonly AdminMenuGroup[] {
  return MENU_GROUPS;
}

/** The groups and menus visible to one account; empty groups are left out. */
export function selectAdminMenuGroups(snapshot: PermissionSnapshot): readonly AdminMenuGroup[] {
  if (snapshot.isSuper) return MENU_GROUPS;
  const access = createAccessControl(snapshot);
  const visible = (item: AdminMenuItem): boolean => {
    switch (item.access.kind) {
      case 'authenticated':
        return true;
      case 'super':
        return access.isSuper;
      case 'any':
        return item.access.permissions.some((permission) => access.can(permission));
    }
  };
  const groups = MENU_GROUPS.map((group) => ({ ...group, items: group.items.filter(visible) }));
  return groups.filter((group) => group.items.length > 0);
}

/** Group and menu for a menu id, or undefined when the id is not in `groups`. */
export function findMenuItem(
  groups: readonly AdminMenuGroup[],
  id: string,
): { readonly group: AdminMenuGroup; readonly item: AdminMenuItem } | undefined {
  for (const group of groups) {
    const item = group.items.find((candidate) => candidate.id === id);
    if (item !== undefined) return { group, item };
  }
  return undefined;
}
