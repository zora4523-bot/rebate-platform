// Owner approval read with the GitHub Actions environment, for guard-git and evidence-check.
// The logic itself is owner-approval.mjs, shared with the protected-paths workflow.
import { checkOwnerApproval, ownerApprovalLabel } from './owner-approval.mjs';
import type { OwnerApproval } from './owner-approval.mjs';

export type { OwnerApproval } from './owner-approval.mjs';
export { ownerApprovalLabel } from './owner-approval.mjs';

/**
 * Approval of pull request `prNumber` for the commit `expectedHead`, read through the API named
 * by GITHUB_API_URL / GITHUB_REPOSITORY / GITHUB_REPOSITORY_OWNER with the token in GH_TOKEN.
 * Never throws: a missing variable or an API error comes back as "not approved" with the reason,
 * so the caller fails closed.
 */
export async function ownerApprovalFromEnv(
  prNumber: string,
  expectedHead: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OwnerApproval> {
  const notApproved = (reason: string): OwnerApproval => ({
    label: ownerApprovalLabel(expectedHead),
    approved: false,
    actor: null,
    reason,
  });
  if (!/^[1-9][0-9]*$/.test(prNumber)) return notApproved(`"${prNumber}" is not a PR number`);
  const api = env['GITHUB_API_URL'];
  const repo = env['GITHUB_REPOSITORY'];
  if (!api || !repo) return notApproved('GITHUB_API_URL and GITHUB_REPOSITORY must be set');
  try {
    return await checkOwnerApproval({
      api,
      repo,
      prNumber,
      owner: env['GITHUB_REPOSITORY_OWNER'],
      token: env['GH_TOKEN'],
      expectedHead,
    });
  } catch (err) {
    return notApproved(
      `the owner approval could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
