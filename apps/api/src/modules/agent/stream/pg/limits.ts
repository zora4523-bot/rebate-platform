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
import { admissionDefaults } from '../admission/index.ts';

export interface QuotaLimitsSource {
  current(appId: string): Promise<AdmissionLimits>;
}

export interface QuotaLimitsSourceDeps {
  readonly reader: Pick<ContentReader, 'configValue'>;
  readonly logger?: Pick<RootLogger, 'warn'>;
}

export function createQuotaLimitsSource(deps: QuotaLimitsSourceDeps): QuotaLimitsSource {
  return {
    async current(appId) {
      const limits = admissionDefaults();
      const keys = [
        ['memberDaily', 'agent.member_daily_quota'],
        ['guestDaily', 'agent.guest_daily_quota'],
        ['guestIpDaily', 'agent.guest_ip_daily_quota'],
      ] as const;
      // ContentReader rejects failed refreshes; never replace that failure with defaults.
      const values = await Promise.all(keys.map(([, key]) => deps.reader.configValue(appId, key)));
      const result = { ...limits };
      keys.forEach(([field, key], index) => {
        const value = values[index]?.value;
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
          result[field] = value;
        } else {
          deps.logger?.warn({ app_id: appId, config_key: key }, 'agent.quota_config_invalid');
        }
      });
      return result;
    },
  };
}
