// Hand-written expectations shared by the resilience rule tests (规划/02 §14, §6.2). They are
// literals on purpose: an expectation must never be computed from the code under test, nor share
// a reference with what it returns (review B1-14a rounds 1–2).
import type {
  DependencyId,
  ResilienceEntry,
} from '../../../../apps/api/src/modules/platform/resilience/index.ts';

export type Row = Omit<ResilienceEntry, 'policy'>;

/** The four columns of 规划/02 §14 plus the owner module, for each row in registry order. */
export function expectedRows(): Row[] {
  return [
    {
      dependency: 'union.search',
      ownerModule: 'catalog',
      failureModes: ['timeout', 'rate_limited'],
      degrade: { action: 'stale_cache_or_error', errorCode: 50304 },
      switches: [],
    },
    {
      dependency: 'union.tpwd_parse',
      ownerModule: 'parsing',
      failureModes: ['permission_missing'],
      degrade: { action: 'guide_title_search', errorCode: 30132 },
      switches: ['parse.tpwd.enabled'],
    },
    {
      dependency: 'model.qwen',
      ownerModule: 'agent',
      failureModes: ['timeout', 'rate_limited', 'server_error', 'budget_exhausted'],
      degrade: { action: 'backup_then_no_model', errorCode: 50302 },
      switches: ['agent.model_route', 'agent.enabled'],
    },
    {
      dependency: 'judge.jev',
      ownerModule: 'judge',
      failureModes: ['timeout', 'rate_limited', 'server_error', 'budget_exhausted'],
      degrade: { action: 'rules_only', errorCode: null },
      switches: ['jev.enabled', 'agent.result_check.provider'],
    },
    {
      dependency: 'content_safety',
      ownerModule: 'agent',
      failureModes: ['timeout'],
      degrade: { action: 'fail_closed', errorCode: null },
      switches: [],
    },
    {
      dependency: 'sms',
      ownerModule: 'notification',
      failureModes: ['channel_down'],
      degrade: { action: 'backup_provider', errorCode: null },
      switches: ['sms.provider'],
    },
    {
      dependency: 'push',
      ownerModule: 'notification',
      failureModes: ['channel_down'],
      degrade: { action: 'inbox_fallback', errorCode: null },
      switches: [],
    },
  ];
}

export function expectedRow(id: DependencyId): Row {
  const found = expectedRows().find((r) => r.dependency === id);
  if (found === undefined) throw new Error(`no expected row for ${id}`);
  return found;
}

/** Copies the row columns out of an entry (fresh object; the policy is left out). */
export function rowOf(e: ResilienceEntry): Row {
  return {
    dependency: e.dependency,
    ownerModule: e.ownerModule,
    failureModes: [...e.failureModes],
    degrade: { action: e.degrade.action, errorCode: e.degrade.errorCode },
    switches: [...e.switches],
  };
}

/** 规划/02 §6.2 online values (unionPolicy('online')), written out. */
export function unionOnlineLiteral(): ResilienceEntry['policy'] {
  return {
    timeoutMs: 3000,
    retries: { maxRetries: 2, baseDelayMs: 200, maxDelayMs: 2000 },
    breaker: { windowMs: 10000, minRequests: 20, failureRatePercent: 50, openMs: 30000 },
  };
}
