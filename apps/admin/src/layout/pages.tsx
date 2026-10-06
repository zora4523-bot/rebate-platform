// Shell-owned pages: no permission yet (design-hifi AdmHomeNoPerm), welcome, a menu whose page
// is not wired yet, and a failed permission load.
import { Link } from 'react-router';
import { noPermissionTexts, shellTexts } from '../texts/shell.ts';

function LockIcon() {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5.5" y="10.5" width="13" height="10" rx="2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </svg>
  );
}

export interface NoPermissionPageProps {
  readonly username: string;
  readonly displayName: string;
  readonly permissionCount: number;
  readonly onRefresh: () => void;
}

export function NoPermissionPage({
  username,
  displayName,
  permissionCount,
  onRefresh,
}: NoPermissionPageProps) {
  return (
    <>
      <h1 className="admin-page-title">{shellTexts.welcomeTitle}</h1>
      <section className="admin-card admin-empty">
        <span className="admin-empty-icon">
          <LockIcon />
        </span>
        <h2 className="admin-empty-title">{noPermissionTexts.title}</h2>
        <p className="admin-empty-description">{noPermissionTexts.description(username)}</p>
        <div className="admin-actions">
          <button type="button" className="admin-button admin-button-primary" onClick={onRefresh}>
            {noPermissionTexts.refresh}
          </button>
          <Link to="/reports" className="admin-button admin-button-default">
            {noPermissionTexts.viewReports}
          </Link>
        </div>
      </section>
      <section className="admin-card admin-card-padded">
        <h2 className="admin-card-title">{noPermissionTexts.availableTitle}</h2>
        <div className="admin-tiles">
          <div className="admin-tile">
            <span className="admin-tile-title">{noPermissionTexts.reportsTitle}</span>
            <span className="admin-secondary">{noPermissionTexts.reportsDescription}</span>
          </div>
          <div className="admin-tile">
            <span className="admin-tile-title">{noPermissionTexts.auditLogsTitle}</span>
            <span className="admin-secondary">{noPermissionTexts.auditLogsDescription}</span>
          </div>
        </div>
        <p className="admin-footnote">
          {noPermissionTexts.accountInfo(username, displayName, permissionCount)}
        </p>
      </section>
    </>
  );
}

export function WelcomePage() {
  return (
    <>
      <h1 className="admin-page-title">{shellTexts.welcomeTitle}</h1>
      <section className="admin-card admin-card-padded">
        <p className="admin-secondary">{shellTexts.welcomeHint}</p>
      </section>
    </>
  );
}

export function PagePending({ title }: { readonly title: string }) {
  return (
    <>
      <h1 className="admin-page-title">{title}</h1>
      <section className="admin-card admin-card-padded">
        <p className="admin-secondary">{shellTexts.pagePendingDescription}</p>
      </section>
    </>
  );
}

export function LoadFailedPage({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <section className="admin-card admin-empty" role="alert">
      <h2 className="admin-empty-title">{shellTexts.loadFailedTitle}</h2>
      <p className="admin-empty-description">{shellTexts.loadFailedDescription}</p>
      <div className="admin-actions">
        <button type="button" className="admin-button admin-button-primary" onClick={onRetry}>
          {shellTexts.retry}
        </button>
      </div>
    </section>
  );
}
