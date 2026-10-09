// The one source of the daily limits (B3-03g design §1.4 「上限来源」, BR-AI-15).
// createQuotaLimitsSource({reader}).current(appId) reads config_items through the process-wide
// ContentReader (cached; at most one cache lifetime old): agent.member_daily_quota → memberDaily,
// agent.guest_daily_quota → guestDaily, agent.guest_ip_daily_quota → guestIpDaily. perMinute and
// maxRounds come from admissionDefaults() (BR-AI-15 sets no configuration for them). A key that is
// missing, or whose value is not a non-negative safe integer, takes the admissionDefaults() value
// of that item and logs warn 'agent.quota_config_invalid' (one warn per bad item and call). A
// reader that rejects makes current() reject (retryable: no fallback to defaults or old values).
// The admission transaction uses the limits its caller passed (B3-03d gets them from the same
// source); independent finalizations (live settle, sweeper) call current() once before F1.
import type { RootLogger } from '../../../platform/index.ts';
import type { ContentReader } from '../../../content/index.ts';
import type { AdmissionLimits } from '../admission/index.ts';

export interface QuotaLimitsSource {
  current(appId: string): Promise<AdmissionLimits>;
}

export interface QuotaLimitsSourceDeps {
  readonly reader: Pick<ContentReader, 'configValue'>;
  readonly logger?: Pick<RootLogger, 'warn'>;
}

export function createQuotaLimitsSource(deps: QuotaLimitsSourceDeps): QuotaLimitsSource {
  void deps;
  throw new Error('NotImplemented: createQuotaLimitsSource');
}
