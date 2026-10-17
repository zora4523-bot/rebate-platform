import { expect, it } from 'vitest';
import { LedgerModule } from '../../../../apps/api/src/modules/ledger/index.ts';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
} from '../../../../apps/api/src/modules/platform/index.ts';

it.each(['api', 'worker', 'admin', 'payout'] as const)(
  '[AC-B2-02f#24] %s 入口装配 ledger 模块',
  async (entry) => {
    // As in the existing entry assembly tests: do not pull decorated controllers into
    // the spec project's erasable-only TypeScript compilation.
    const { AppModule } = (await import(
      new URL('../../../../apps/api/src/app.module.ts', import.meta.url).href
    )) as { AppModule: { forEntry(options: object): { imports?: readonly unknown[] } } };
    const root = AppModule.forEntry({
      entry,
      config: loadConfig({ APP_ENV: 'test' }),
      clock: new FixedClock('2032-06-15T15:59:59.999Z'),
      logger: createRootLogger({ level: 'silent', entry, appEnv: 'test' }, { write() {} }),
    });
    const modules = (root.imports ?? []).map((item) =>
      typeof item === 'object' && item !== null && 'module' in item ? item.module : item,
    );
    expect(modules).toContain(LedgerModule);
  },
);
