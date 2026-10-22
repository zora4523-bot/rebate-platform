export interface StagingDependencyConfig {
  readonly databaseUrl: string;
  readonly redisUrl?: string;
}

/**
 * Compose's one-shot probe: PG query for both entries, Redis PING for worker only.
 * Return false on missing required URLs or dependency failure; never use a fallback role.
 */
export async function checkStagingDependencies(
  entry: 'worker' | 'payout',
  config: StagingDependencyConfig,
): Promise<boolean> {
  void entry;
  void config;
  throw new Error('NotImplemented: checkStagingDependencies');
}
