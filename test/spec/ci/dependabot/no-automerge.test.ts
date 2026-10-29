import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { CONFIG, asset, dependabot, keyPaths, rootUrl } from './kit.ts';

// 规划/05 CT-23: Dependabot only opens PRs; they still go through a deps task and the adversarial
// review, so nothing may merge or approve them automatically.
const AUTOMERGE_ANYWHERE = [
  /gh\s+pr\s+merge\b[^\n]*--auto\b/,
  /gh\s+pr\s+review\b[^\n]*(--approve\b|\s-a\b)/,
  /enablePullRequestAutoMerge/,
  /auto_merge\s*[:=]/,
  /pascalgn\/automerge-action|peter-evans\/enable-pull-request-automerge/i,
  /hmarr\/auto-approve-action|fastify\/github-action-merge-dependabot/i,
  /ahmadnassri\/action-dependabot-auto-merge/i,
];
// Extra patterns for workflows that refer to Dependabot at all.
const MERGE_OR_APPROVE = [
  /gh\s+pr\s+(merge|review)\b/,
  /auto-?merge/i,
  /pulls\.(merge|createReview)\b/,
  /\bAPPROVE\b/,
  /--approve\b/,
];

it('[CT-23#7] dependabot.yml 里没有任何自动合并 / 自动批准的写法', () => {
  const document = dependabot();
  const offending = keyPaths(document).filter((path) => /auto.?merge|approve/i.test(path));
  expect(offending, '配置里不得有自动合并 / 批准的键').toEqual([]);
  const values = JSON.stringify(document);
  expect(values, '配置里不得有自动合并 / 批准的值').not.toMatch(/auto.?merge|approve/i);
});

it('[CT-23#8] 交付 dependabot.yml，且 .github/workflows 里没有对依赖 PR 的自动合并 / 自动批准', () => {
  asset(CONFIG);
  const dir = rootUrl('.github/workflows/');
  const files = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name));
  expect(files.length, '.github/workflows 下应有工作流').toBeGreaterThan(0);
  for (const name of files) {
    const text = readFileSync(new URL(name, dir), 'utf8');
    for (const pattern of AUTOMERGE_ANYWHERE) {
      expect(text, `${name} 不得自动合并 / 批准 PR`).not.toMatch(pattern);
    }
    if (!/dependabot/i.test(text)) continue;
    for (const pattern of MERGE_OR_APPROVE) {
      expect(text, `${name} 不得合并 / 批准 dependabot 的 PR`).not.toMatch(pattern);
    }
  }
});
