// Types of owner-approval.mjs (plain JavaScript, because a verbatim copy of it runs inline in
// .github/workflows/protected-paths.yml).

export type OwnerApproval = {
  /** `owner-approved-<first 12 hex digits of the checked head>`. */
  label: string;
  approved: boolean;
  /** Who added the label according to the PR timeline, when it is on the PR. */
  actor: string | null;
  /** One line for the log, whatever the outcome. */
  reason: string;
};

export type OwnerApprovalOptions = {
  /** GITHUB_API_URL. */
  api: string;
  /** owner/name (GITHUB_REPOSITORY). */
  repo: string;
  prNumber: string | number;
  /** The repository owner account (GITHUB_REPOSITORY_OWNER). */
  owner: string | undefined;
  token: string | undefined;
  /** The full commit id that was checked; the approval must be for exactly this head. */
  expectedHead: string;
  /** The PR object when the caller has already read it (saves one request). */
  pr?: unknown;
};

export declare function ownerApprovalLabel(headSha: string): string;

export declare function checkOwnerApproval(options: OwnerApprovalOptions): Promise<OwnerApproval>;
