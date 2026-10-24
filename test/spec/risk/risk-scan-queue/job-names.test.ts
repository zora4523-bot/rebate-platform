// B1-03w regression guard (orchestrator 19:28): every job name apps/api/src hands to the queue,
// compares a received job with, or defines centrally, must pass the job-name rule of
// platform/queue (validateSend imported from validation.ts itself, not a copy of its regex).
// The scan is static — source text parsed by the TypeScript parser, nothing imported or run; what
// it collects, how it resolves names and the forms it cannot see (names built at run time, …) are
// written in ./job-names.ts. Unresolved sites are not violations, except in the risk module,
// whose chain must stay statically checkable.
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  QueueError,
  type QueueSpec,
} from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { validateSend } from '../../../../apps/api/src/modules/platform/queue/validation.ts';
import { scanJobNames, type NameSite } from './job-names.ts';

const ROOT = fileURLToPath(new URL('../../../../apps/api/src/', import.meta.url));

/** A standard queue: validateSend then checks nothing but the name, payload and `trx`. */
const SPEC: QueueSpec = {
  name: 'job-name-rule',
  policy: 'standard',
  retryLimit: 0,
  retryDelaySeconds: 1,
  retryBackoff: false,
  retryDelayMaxSeconds: null,
  expireInSeconds: 60,
  retentionSeconds: 60,
  deleteAfterSeconds: 60,
  deadLetter: null,
};

/** null when validateSend accepts `name`, else the QueueError code (or what was thrown). */
function rejection(name: string): string | null {
  try {
    validateSend(SPEC, name, {}, { trx: null });
    return null;
  } catch (error) {
    return error instanceof QueueError ? error.code : String(error);
  }
}

/** `<file>:<line> <kind> '<name>' <code>` of every resolved name the rule rejects. */
function violations(sites: readonly NameSite[]): string[] {
  return sites.flatMap((site) =>
    (site.names ?? []).flatMap((name) => {
      const code = rejection(name);
      return code === null ? [] : [`${site.file}:${site.line} ${site.kind} '${name}' ${code}`];
    }),
  );
}

it('[B1-03w#6] risk 模块：任务链的发送点、handler 分派与任务名常量都能静态解析，每个名字都过 validateSend 的任务名规则，发送的名字恰为 freeze_expiry / daily_alerts', () => {
  const sites = scanJobNames(ROOT).filter((site) => site.file.startsWith('modules/risk/'));
  const chain = sites.filter((site) => site.file === 'modules/risk/application/risk-scan.ts');
  expect(violations(sites)).toEqual([]);
  expect(sites.filter((site) => site.names === null)).toEqual([]);
  expect(chain.filter((site) => site.kind === 'send').length).toBeGreaterThan(0);
  expect(
    [
      ...new Set(chain.filter((site) => site.kind === 'send').flatMap((site) => site.names ?? [])),
    ].sort(),
  ).toEqual(['daily_alerts', 'freeze_expiry']);
});

it('[B1-03w#7] apps/api/src 全仓：发送点、handler 分派与任务名常量里静态可解析的任务名零违例', () => {
  const sites = scanJobNames(ROOT);
  // Not vacuous: the scan sees sends with resolved names across several modules.
  const sending = new Set(
    sites
      .filter((site) => site.kind === 'send' && site.names !== null)
      .map((site) => site.file.split('/')[1]),
  );
  expect(sending.size).toBeGreaterThan(1);
  expect(violations(sites)).toEqual([]);
});
