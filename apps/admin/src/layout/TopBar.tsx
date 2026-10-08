import { useEffect, useRef, useState } from 'react';
import type { AdminEnvironment } from '../shell-options.ts';
import { shellTexts } from '../texts/shell.ts';

export interface TopBarProps {
  readonly crumbs: readonly string[];
  readonly environment: AdminEnvironment;
  readonly displayName: string;
  /** A returned promise keeps 【退出】 disabled until the request ends (success, failure, timeout). */
  readonly onLogout: () => void | Promise<unknown>;
}

/** Breadcrumb on the left; environment tag, account and logout on the right. */
export function TopBar({ crumbs, environment, displayName, onLogout }: TopBarProps) {
  const [loggingOut, setLoggingOut] = useState(false);
  // The click handler reads this, so a second click in the same frame is ignored too.
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function logout(): void {
    if (inFlight.current) return;
    const request = onLogout();
    if (request === undefined) return;
    inFlight.current = true;
    setLoggingOut(true);
    const settle = (): void => {
      inFlight.current = false;
      if (mounted.current) setLoggingOut(false);
    };
    void request.then(settle, settle);
  }

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
        <button
          type="button"
          className="admin-logout"
          disabled={loggingOut}
          aria-busy={loggingOut || undefined}
          onClick={logout}
        >
          {shellTexts.logout}
        </button>
      </div>
    </header>
  );
}
