import { Link } from 'react-router';
import type { AdminMenuGroup } from '../resources/index.ts';
import { shellTexts } from '../texts/shell.ts';

export interface SidebarProps {
  readonly groups: readonly AdminMenuGroup[];
  readonly activeId: string | undefined;
}

/** Brand plus the permitted menu groups, in catalogue order (design-hifi AdmStepUp). */
export function Sidebar({ groups, activeId }: SidebarProps) {
  return (
    <nav className="admin-sidebar" aria-label={shellTexts.mainNavigation}>
      <div className="admin-brand">
        <span className="admin-brand-logo" aria-hidden="true">
          {shellTexts.brandLogo}
        </span>
        <span className="admin-brand-name">{shellTexts.brand}</span>
      </div>
      <div className="admin-menu">
        {groups.map((group) => (
          <div key={group.key} className="admin-menu-group">
            <h2 className="admin-menu-heading">{group.label}</h2>
            <ul className="admin-menu-list">
              {group.items.map((item) => (
                <li key={item.id}>
                  <Link
                    to={`/${item.id}`}
                    className="admin-menu-link"
                    aria-current={item.id === activeId ? 'page' : undefined}
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
