import { expect, it, vi } from 'vitest';
import type { DeletionStageChecks } from '../../../../apps/api/src/modules/identity/application/deletion-guard.ts';
import { NOW, ROOT } from '../deletion-guard/kit.ts';
import { modules } from './kit.ts';

it('[AC-B1-15m#1] stream 的两份列表只装 ⑥：注入 DELETION_STAGE_CHECKS，不夹带 ⑦⑧⑨ 或 step-up', async () => {
  const { platform, risk, identity } = await modules();
  const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as {
    AppModule: { forEntry(options: object): unknown };
  };
  const spy = vi.spyOn(risk.RiskModule, 'forRoot');
  try {
    AppModule.forEntry({
      entry: 'stream',
      config: platform.loadConfig({ APP_ENV: 'test' }),
      clock: new platform.FixedClock(NOW),
      logger: platform.createRootLogger({ level: 'silent', entry: 'stream', appEnv: 'test' }),
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const options = spy.mock.calls[0]![0];
    expect(options.beforeRateLimit, 'stream 未接 post-miss 列表').toBeDefined();
    expect(options.beforeRateLimitGuards, 'stream 未接守卫列表').toBeDefined();
    const checks: DeletionStageChecks = {
      guard: { canActivate: async () => true },
      postMiss: async () => undefined,
    };
    expect(options.beforeRateLimit!.inject).toEqual([identity.DELETION_STAGE_CHECKS]);
    expect(options.beforeRateLimitGuards!.inject).toEqual([identity.DELETION_STAGE_CHECKS]);
    const hooks = options.beforeRateLimit!.useFactory(checks);
    const guards = options.beforeRateLimitGuards!.useFactory(checks);
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toBe(checks.postMiss);
    expect(guards).toHaveLength(1);
    expect(guards[0]).toBe(checks.guard);
  } finally {
    spy.mockRestore();
  }
});
