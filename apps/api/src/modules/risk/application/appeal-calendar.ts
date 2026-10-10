import type { Clock, RootLogger } from '../../platform/index.ts';
import type { RateLimitConfigReader } from './rate-limit.ts';

export interface AppealCalendarOptions {
  readonly appId: string;
  readonly clock: Clock;
  readonly config: RateLimitConfigReader;
  readonly logger: Pick<RootLogger, 'warn'>;
}

/** Read per-year configuration; unavailable/invalid calendars fall back with a private warning. */
export function resolveAppealDeadline(options: AppealCalendarOptions): Promise<Date> {
  void options;
  throw new Error('NotImplemented: resolveAppealDeadline');
}
