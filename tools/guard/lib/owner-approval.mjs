// Owner approval of a pull request (规划/11 §4.4): the one implementation used by the
// `protected-paths` workflow (a verbatim copy between its BEGIN / END owner-approval.mjs marker
// lines, kept identical by the protected-sync guard), by `tools/guard/run.ts git` (CI job
// guard-git) and by `tools/ci/evidence-check.ts`.
// Plain JavaScript without imports or type syntax: the workflow copy runs as an inline script
// on the runner's own node, with no checkout and no install. Types: owner-approval.d.mts.
//
// Approved means all of: the PR head is still `expectedHead` (the commit that was checked); the
// PR carries the label `owner-approved-<first 12 hex digits of that head>`, so a label for an
// older head never matches; and the last `labeled` event for that label in the PR timeline was
// made by the repository owner account (any other actor, app or bot: not approved).
// HTTP errors throw; every caller fails closed.

export function ownerApprovalLabel(headSha) {
  return 'owner-approved-' + String(headSha).slice(0, 12);
}

export async function checkOwnerApproval(options) {
  const expectedHead = String(options.expectedHead);
  const label = ownerApprovalLabel(expectedHead);
  const outcome = { label, approved: false, actor: null, reason: '' };
  const getJson = async (path) => {
    const res = await fetch(options.api + path, {
      headers: {
        authorization: 'Bearer ' + options.token,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'couli-owner-approval',
      },
    });
    if (!res.ok) throw new Error('GET ' + path + ' -> HTTP ' + res.status);
    return res.json();
  };
  if (!/^[0-9a-f]{40,64}$/.test(expectedHead)) {
    outcome.reason = 'the checked head ' + expectedHead + ' is not a full commit id';
    return outcome;
  }
  const prPath = '/repos/' + options.repo + '/pulls/' + options.prNumber;
  const pr = options.pr ?? (await getJson(prPath));
  const headSha = pr && pr.head ? pr.head.sha : null;
  if (headSha !== expectedHead) {
    outcome.reason = 'the PR head is ' + headSha + ', not the checked head ' + expectedHead;
    return outcome;
  }
  const labels = Array.isArray(pr.labels) ? pr.labels : [];
  if (!labels.some((entry) => entry && entry.name === label)) {
    outcome.reason = 'the PR does not carry the label `' + label + '`';
    return outcome;
  }
  if (!options.owner) throw new Error('GITHUB_REPOSITORY_OWNER is not set');
  const events = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await getJson(
      '/repos/' +
        options.repo +
        '/issues/' +
        options.prNumber +
        '/events?per_page=100&page=' +
        page,
    );
    events.push(...batch);
    if (batch.length < 100) break;
  }
  const labelings = events.filter(
    (e) => e && e.event === 'labeled' && e.label && e.label.name === label,
  );
  const last = labelings[labelings.length - 1];
  outcome.actor = last && last.actor ? last.actor.login : null;
  outcome.approved = outcome.actor === options.owner;
  outcome.reason = outcome.approved
    ? 'label `' + label + '` added by the owner account ' + outcome.actor
    : outcome.actor === null
      ? 'the PR timeline has no `labeled` event for `' + label + '`'
      : 'label `' + label + '` was added by `' + outcome.actor + '`, not by the owner account';
  return outcome;
}
