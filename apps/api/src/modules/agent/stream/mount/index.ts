// The stream entry's assembly of the agent module (B3-03f; B3-05-plan §1.1, §3.3; B3-03g design
// §5.1, §6.2; followups 18, 21–23, 30, 31; BR-AI-13, BR-AI-23). The rule tests in
// test/spec/agent/stream-mount/** import this file by path: names, signatures and the semantics
// written here are the contract. AgentModule.forStream(options) (agent.module.ts) provides
// agentStreamProvider(options) and exports agentStreamToken(); app.module imports it on the
// `stream` entry only, handing identity's createAiConsentReader in as options.consentReader (agent
// never imports identity), and gives the stream entry's request check plan identity's token check
// ② ③ (no signature check). api, worker, admin and payout neither import it nor serve
// /v1/agent/*; stream starts no sweeper.
//
// agentStreamToken(): the DI token of the stream runtime; the same symbol on every call.
// agentStreamProvider(options): the Nest factory provider of agentStreamToken(), injected [CLOCK,
//   ROOT_LOGGER, {token: DB, optional: true}, {token: REDIS, optional: true}]. Without a DB handle
//   its value is null and one info line 'agent_stream_disabled' is logged; with one it is
//   createAgentStreamRuntime({db, clock, logger, signals?, consentReader: options.consentReader}).
//   The four routes of B3-03d (createAgentSession, getCurrentAgentSession, sendAgentMessage,
//   cancelAgentRun) are registered either way; without a runtime each answers the JSON 50001
//   envelope. On application shutdown runtime.close() resolves before the platform closes the
//   database handles (Nest lifecycle; entry.ts unchanged).
// createAgentStreamRuntime(deps, seams?) → AgentStreamRuntime, built with nothing running (no
//   timer, no query):
//   texts: errorMsg = agentDefaultTexts().errorMsg; the run texts' text(appId, key) =
//   texts['<key>'] of contracts/texts.default.json. timings = runTimingsDefaults(), frozen at
//   build; runConfig = {...runConfigDefaults(), maxRunMs: timings.runMaxMs} with
//   0 < guardPollMs ≤ 5 000; assertRunTimings({...timings, admissionRunMaxMs: runConfig.maxRunMs,
//   sweepMarginMs: 0}) is called at build (a throw: the entry does not start).
//   limits = createQuotaLimitsSource({reader: createContentReader({db, clock}), logger}): ONE
//   instance, given to createPgRunPorts({db, clock, timings, limits, texts, signals?, logger}) and
//   to AgentHttpDeps.limits, and exposed as runtime.limits.
//   runs = createRunManager on the PG ports' admission and registry, config runConfig, guardFor =
//   B3-03i createRunGuardFactory, scheduler = seams.schedule ?? the system scheduler.
//   access / identity / consent = B3-03i createAgentAccessPort / createAgentIdentityPort /
//   createAgentConsentPort; consent over deps.consentReader({db, currentVersion: version}) with
//   version = createConsentVersionSource({reader, logger}); the same version source goes to the
//   guard factory. The reader through which access and the guard read the agent.* switches caches
//   for at most 5 000 ms on the injected Clock (followup 23: a switch turned off is seen by a new
//   request 5 s later and ends a live run within 10 s); other keys keep content's reader.
//   redactor = B3-05a createAgentRedactor(); traceMask(args, table) =
//   maskForTrace(restorePlaceholders(args, table)) (followup 22), also runtime.traceMask.
//   body = B3-05b createAgentRunBody({tools: seams.tools ?? emptyOrchestratorTools(), inputCheck:
//   seams.inputCheck ?? failClosedInputCheck(), degraded: B3-05c createDegradedPath over the same
//   tools and texts, without onTrace (followup 31); no intents, no deterministic; review always
//   answers timeout; the route is fixed to no_model; prompt always null; limits:
//   orchestratorLimitsDefaults(); traceMask}); labels = createRunLabels over the same route and
//   prompt; sessions = createPgAgentSessionStore; ids = new UUIDv7 ids. No model transport is ever
//   called. seams are test seams only (production passes none).
//   close(): stops accepting (a message after close() started is refused and opens no run), waits
//   for the runs in progress to end (at most timings.runMaxMs plus a margin; a run still live after
//   that is left to the worker's sweeper), then resolves. It never closes the database. The
//   runtime is a plain (not frozen) object; whoever stops it calls runtime.close() through it.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`, no process.env, no import of identity.
import type { FactoryProvider } from '@nestjs/common';
import type { DB as Database } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, RootLogger, Scheduler } from '../../../platform/index.ts';
import type { AgentHttp } from '../../http/index.ts';
import type { InputCheckPort, OrchestratorTools } from '../../orchestrator/index.ts';
import type { AgentConsentReader } from '../access/index.ts';
import type { QuotaLimitsSource, RunTimings } from '../pg/index.ts';
import type { RunConfig, RunRegistry, RunTexts } from '../run/index.ts';

/** identity's createAiConsentReader (B1-02r), handed in by app.module (agent never imports it). */
export type AgentConsentReaderFactory = (options: {
  readonly db: Kysely<Database>;
  readonly currentVersion: (appId: string) => Promise<number>;
}) => AgentConsentReader;

export interface AgentStreamRuntimeDeps {
  readonly db: Kysely<Database>;
  readonly clock: Clock;
  readonly logger: RootLogger;
  /** Redis fast path of cancel signals; absent without Redis. */
  readonly signals?: Pick<RunRegistry, 'requestCancel' | 'cancelRequested'>;
  readonly consentReader: AgentConsentReaderFactory;
}

/** Test seams only; production passes none. */
export interface AgentStreamSeams {
  readonly inputCheck?: InputCheckPort;
  readonly tools?: OrchestratorTools;
  /** The RunManager's scheduler (the system scheduler otherwise). */
  readonly schedule?: Scheduler;
}

export interface AgentStreamRuntime {
  readonly http: AgentHttp;
  readonly timings: RunTimings;
  readonly runConfig: RunConfig;
  /** The one QuotaLimitsSource of the HTTP layer and the PG ports. */
  readonly limits: QuotaLimitsSource;
  readonly texts: Pick<RunTexts, 'errorMsg'>;
  traceMask(args: unknown, placeholders: Readonly<Record<string, string>>): unknown;
  close(): Promise<void>;
}

export interface AgentStreamModuleOptions {
  readonly consentReader: AgentConsentReaderFactory;
}

export function agentStreamToken(): symbol {
  throw new Error('NotImplemented: agentStreamToken');
}

export function agentStreamProvider(options: AgentStreamModuleOptions): FactoryProvider {
  void options;
  throw new Error('NotImplemented: agentStreamProvider');
}

export function createAgentStreamRuntime(
  deps: AgentStreamRuntimeDeps,
  seams?: AgentStreamSeams,
): AgentStreamRuntime {
  void deps;
  void seams;
  throw new Error('NotImplemented: createAgentStreamRuntime');
}
