// owner-approval.mjs (shared with the protected-paths workflow) and its environment wrapper,
// against a stubbed fetch: the label must be for exactly the checked head and added by the owner.
import { afterEach, expect, it, vi } from 'vitest';
import { checkOwnerApproval, ownerApprovalLabel } from './owner-approval.mjs';
import { ownerApprovalFromEnv } from './owner-approval-env.ts';

const API = 'https://api.github.invalid';
const HEAD = 'a'.repeat(40);
const OLDER = 'b'.repeat(40);
const LABEL = `owner-approved-${HEAD.slice(0, 12)}`;

type Scenario = {
  liveHead?: string;
  labels?: string[];
  /** Labeled events in timeline order: [label, actor]. Default: each label added by `o`. */
  events?: [string, string][];
  status?: number;
};

/** Stubs fetch with a PR #7 of o/r; returns the list of requested paths. */
function stubGitHub(scenario: Scenario): string[] {
  const requested: string[] = [];
  const labels = scenario.labels ?? [];
  const events = scenario.events ?? labels.map((name): [string, string] => [name, 'o']);
  vi.stubGlobal('fetch', (input: string) => {
    const path = input.slice(API.length);
    requested.push(path);
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), { status: scenario.status ?? 200 });
    if (path === '/repos/o/r/pulls/7') {
      return Promise.resolve(
        json({
          head: { sha: scenario.liveHead ?? HEAD },
          labels: labels.map((name) => ({ name })),
        }),
      );
    }
    if (path === '/repos/o/r/issues/7/events?per_page=100&page=1') {
      return Promise.resolve(
        json(
          events.map(([name, actor]) => ({
            event: 'labeled',
            label: { name },
            actor: { login: actor },
          })),
        ),
      );
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  });
  return requested;
}

const options = { api: API, repo: 'o/r', prNumber: 7, owner: 'o', token: 't', expectedHead: HEAD };
const env = {
  GITHUB_API_URL: API,
  GITHUB_REPOSITORY: 'o/r',
  GITHUB_REPOSITORY_OWNER: 'o',
  GH_TOKEN: 't',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

it('the label is owner-approved- plus the first 12 hex digits of the head', () => {
  expect(ownerApprovalLabel(HEAD)).toBe(LABEL);
});

it('approves the label for the checked head when the owner account added it', async () => {
  stubGitHub({ labels: [LABEL] });
  expect(await checkOwnerApproval(options)).toEqual({
    label: LABEL,
    approved: true,
    actor: 'o',
    reason: `label \`${LABEL}\` added by the owner account o`,
  });
});

it('a label for an older head does not approve the current head', async () => {
  const requested = stubGitHub({ labels: [ownerApprovalLabel(OLDER)] });
  const outcome = await checkOwnerApproval(options);
  expect(outcome).toMatchObject({ approved: false, actor: null });
  expect(outcome.reason).toContain(`does not carry the label \`${LABEL}\``);
  // Without the label the timeline is not even read.
  expect(requested).toEqual(['/repos/o/r/pulls/7']);
});

it('a label added by any account other than the owner does not approve', async () => {
  stubGitHub({ labels: [LABEL], events: [[LABEL, 'ci-bot']] });
  const byBot = await checkOwnerApproval(options);
  expect(byBot).toMatchObject({ approved: false, actor: 'ci-bot' });
  expect(byBot.reason).toContain('not by the owner account');
  // The last labeling counts: added by the owner, removed, then re-added by someone else.
  stubGitHub({
    labels: [LABEL],
    events: [
      [LABEL, 'o'],
      [LABEL, 'ci-bot'],
    ],
  });
  expect(await checkOwnerApproval(options)).toMatchObject({ approved: false, actor: 'ci-bot' });
  stubGitHub({ labels: [LABEL], events: [] });
  expect(await checkOwnerApproval(options)).toMatchObject({ approved: false, actor: null });
});

it('the checked head must still be the PR head and a full commit id', async () => {
  stubGitHub({ labels: [LABEL], liveHead: OLDER });
  const moved = await checkOwnerApproval(options);
  expect(moved.approved).toBe(false);
  expect(moved.reason).toContain(`the PR head is ${OLDER}`);
  stubGitHub({ labels: [LABEL] });
  const short = await checkOwnerApproval({ ...options, expectedHead: HEAD.slice(0, 12) });
  expect(short.approved).toBe(false);
  expect(short.reason).toContain('not a full commit id');
});

it('HTTP errors and a missing owner throw; the environment wrapper turns them into a no', async () => {
  stubGitHub({ labels: [LABEL], status: 500 });
  await expect(checkOwnerApproval(options)).rejects.toThrow(/HTTP 500/);
  const failed = await ownerApprovalFromEnv('7', HEAD, env);
  expect(failed.approved).toBe(false);
  expect(failed.reason).toContain('could not be read: GET /repos/o/r/pulls/7 -> HTTP 500');

  stubGitHub({ labels: [LABEL] });
  await expect(checkOwnerApproval({ ...options, owner: undefined })).rejects.toThrow(
    /GITHUB_REPOSITORY_OWNER/,
  );
  expect(await ownerApprovalFromEnv('7', HEAD, env)).toMatchObject({ approved: true, actor: 'o' });
  expect(
    (await ownerApprovalFromEnv('7', HEAD, { ...env, GITHUB_REPOSITORY_OWNER: '' })).approved,
  ).toBe(false);
  expect((await ownerApprovalFromEnv('7', HEAD, { GH_TOKEN: 't' })).reason).toContain(
    'GITHUB_API_URL and GITHUB_REPOSITORY must be set',
  );
  expect((await ownerApprovalFromEnv('x7', HEAD, env)).reason).toContain('not a PR number');
});
