// The agent module's worker assembly (B3-03h; design couli-runs/B3-03g/design.md v5 §5.3 「worker 内
// 循环 + advisory lock」, §5.1, §7.4 B3-03h, §10.1 T10 / T14; BR-AI-23 细则「受理记录与收尾 · 谁来收尾」,
// BR-AI-15 退还). app.module imports AgentModule.forWorker() on the `worker` entry only; entry.ts
// starts the loop after startWorkerServices and stops it first on shutdown. The HTTP mount on the
// stream entry is B3-03f's, not this file's. Rule tests: test/spec/agent/stream-recovery/** import
// this file by path: names, signatures and the semantics written here are the contract.
//
// agentSweeperToken(): the DI token of the worker's sweeper runtime; the same symbol on every call.
// agentDefaultTexts(): {errorMsg(code)} over contracts/texts.default.json, read synchronously once
//   when this module is loaded (path relative to import.meta.url, as linking's apps-json.ts does;
//   the same depth in the build output). errorMsg(code) = fallbacks['error.<code>'] when present (the
//   08 「变量缺失时」 form: a server-side frame has no placeholder values), else texts['error.<code>'],
//   else errorMsg(50001). A returned text never contains a `{name}` placeholder. Stand-in until a
//   texts service exists (BR-TEXT-14); every call returns the same object.
// createAgentSweeperRuntime({db, clock, logger}) → AgentSweeperRuntime, built with nothing running:
//   texts = agentDefaultTexts(); timings = runTimingsDefaults(); sweeperConfig = sweeperDefaults();
//   loopConfig = agentSweepLoopDefaults() with loopConfig.maxPerTick = sweeperConfig.maxPerTick
//   (each a fresh value of those functions; T14: the one frozen RunTimings,
//   assertRunTimings({...timings, admissionRunMaxMs: timings.runMaxMs, sweepMarginMs:
//   sweeperConfig.marginMs}) holds);
//   finalizer = createPgRunPorts({db, clock, timings, limits: createQuotaLimitsSource({reader:
//   createContentReader({db, clock}), logger}), texts, logger}).finalizer (no signals: the sweeper
//   needs no Redis); step = createSweeper({db, finalizer, clock, config: {...sweeperConfig,
//   maxPerTick: 1}, logger}) — one row per call, so the loop can stop between rows (loop.ts).
//   start(options?) = startAgentSweeper({step, db, clock, logger, config: loopConfig,
//   ...options}) — every call starts one more loop (entry.ts calls it once).
// AgentModule.forWorker(): a DynamicModule providing and exporting agentSweeperToken(), injected
//   [CLOCK, ROOT_LOGGER, {token: DB, optional: true}]. Without a DB handle the provider is null and
//   one info line 'agent_sweeper_disabled' is logged (as RiskScanModule's 'risk_scan_disabled');
//   with one it is createAgentSweeperRuntime({db, clock, logger}). Building it starts nothing (no
//   timer, no query).
// entry.ts (worker only, after startWorkerServices resolved and before `started`): resolves the
//   token with context.get(agentSweeperToken(), {strict: false}); a throw, null, undefined or a
//   value without a start function → no loop, no crash (as startRiskScanHeal); a stop already
//   requested → no loop. Shutdown awaits loop.stop() before services.stop() (services.stop runs
//   even when loop.stop rejects). COULI_EXIT_AFTER_INIT=1 and the api / stream / admin / payout
//   entries never start it.
//
// Also compiled by the `test` project: a class decorator only (no parameter decorators or
// parameter properties; dependencies are injected through factories); erasable syntax only,
// `import type` for type-only imports, relative imports with `.ts`, no process.env.
import type { DynamicModule } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, RootLogger } from '../platform/index.ts';
import type { RunTimings } from './stream/pg/index.ts';
import type { RunTexts } from './stream/run/index.ts';
import type { Sweeper, SweeperConfig } from './stream/sweeper/index.ts';
import type {
  AgentSweepLoop,
  AgentSweepLoopConfig,
  AgentSweepSchedule,
} from './stream/sweeper/loop.ts';

export type {
  AgentSweepLoop,
  AgentSweepLoopConfig,
  AgentSweepLoopDeps,
  AgentSweepSchedule,
  AgentSweepTimer,
  AgentSweepTimerHandle,
} from './stream/sweeper/loop.ts';

export interface AgentSweeperRuntimeDeps {
  readonly db: Kysely<Database>;
  readonly clock: Clock;
  readonly logger: RootLogger;
}

/** Test seams of one loop start; production passes nothing. */
export interface AgentSweeperStartOptions {
  readonly schedule?: AgentSweepSchedule;
  readonly random?: () => number;
}

export interface AgentSweeperRuntime {
  readonly texts: Pick<RunTexts, 'errorMsg'>;
  readonly timings: RunTimings;
  readonly sweeperConfig: SweeperConfig;
  readonly loopConfig: AgentSweepLoopConfig;
  /** The one-row sweeper the loop calls row by row (createSweeper with maxPerTick 1). */
  readonly step: Sweeper;
  start(options?: AgentSweeperStartOptions): AgentSweepLoop;
}

export function agentSweeperToken(): symbol {
  throw new Error('NotImplemented: agentSweeperToken (B3-03h)');
}

export function agentDefaultTexts(): Pick<RunTexts, 'errorMsg'> {
  throw new Error('NotImplemented: agentDefaultTexts (B3-03h)');
}

export function createAgentSweeperRuntime(deps: AgentSweeperRuntimeDeps): AgentSweeperRuntime {
  void deps;
  throw new Error('NotImplemented: createAgentSweeperRuntime (B3-03h)');
}

export class AgentModule {
  static forWorker(): DynamicModule {
    throw new Error('NotImplemented: AgentModule.forWorker (B3-03h)');
  }
}
