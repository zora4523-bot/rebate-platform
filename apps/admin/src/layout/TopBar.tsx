import type { AdminEnvironment } from '../shell-options.ts';
import { shellTexts } from '../texts/shell.ts';

export interface TopBarProps {
  readonly crumbs: readonly string[];
  readonly environment: AdminEnvironment;
  readonly displayName: string;
  readonly onLogout: () => void;
}

/** Breadcrumb on the left; environment tag, account and logout on the right. */
export function TopBar({ crumbs, environment, displayName, onLogout }: TopBarProps) {
  return (
    <header className="admin-topbar">
      <nav className="admin-breadcrumb" aria-label={shellTexts.breadcrumb}>
        <ol>
          {crumbs.map((crumb, index) => (
            <li key={index} aria-current={index === crumbs.length - 1 ? 'page' : undefined}>
              {crumb}
            </li>
          ))}
        </ol>
      </nav>
      <div className="admin-topbar-account">
        {environment === 'production' ? null : (
          <span className="admin-env-tag">{shellTexts.nonProductionEnvironment}</span>
        )}
        <span>{displayName}</span>
        <button type="button" className="admin-logout" onClick={onLogout}>
          {shellTexts.logout}
        </button>
      </div>
    </header>
  );
}
