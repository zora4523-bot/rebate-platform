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
import { sql, type Kysely } from 'kysely';
import { createContentReader } from '../../../content/index.ts';
import {
  CLOCK,
  DB,
  REDIS,
  ROOT_LOGGER,
  newUuidV7,
  systemScheduler,
  type Clock,
  type RedisHandle,
  type RootLogger,
  type Scheduler,
} from '../../../platform/index.ts';
import { agentHttpDefaults, createAgentHttp, type AgentHttp } from '../../http/index.ts';
import {
  createAgentRunBody,
  createRunLabels,
  emptyOrchestratorTools,
  failClosedInputCheck,
  orchestratorLimitsDefaults,
  type InputCheckPort,
  type OrchestratorTools,
  type AgentRunTexts,
} from '../../orchestrator/index.ts';
import { createDegradedPath } from '../../orchestrator/degraded/index.ts';
import { createRunModelClock, type ResolvedRoute } from '../../model-gateway/routing/index.ts';
import {
  createAgentRedactor,
  maskForTrace,
  restorePlaceholders,
} from '../../preprocess/redact/index.ts';
import { agentSessionDefaults, createPgAgentSessionStore } from '../../store/index.ts';
import {
  createAgentAccessPort,
  createAgentIdentityPort,
  createAgentConsentPort,
  createConsentVersionSource,
  createRunGuardFactory,
  type AgentConsentReader,
} from '../access/index.ts';
import {
  assertRunTimings,
  createPgRunPorts,
  createQuotaLimitsSource,
  runTimingsDefaults,
  type QuotaLimitsSource,
  type RunTimings,
} from '../pg/index.ts';
import {
  createRunManager,
  runConfigDefaults,
  type RunConfig,
  type RunRegistry,
  type RunTexts,
} from '../run/index.ts';
import { createAgentSwitchReader } from './config.ts';
import { agentDefaultTexts, agentText } from './texts.ts';
import type { AgentCallerReaderFactory } from './caller.ts';

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
  readonly callerReader: AgentCallerReaderFactory;
}

const STREAM_RUNTIME = Symbol('AGENT_STREAM_RUNTIME');

export function agentStreamToken(): symbol {
  return STREAM_RUNTIME;
}

export function agentStreamProvider(
  options: Pick<AgentStreamModuleOptions, 'consentReader'>,
): FactoryProvider {
  return {
    provide: agentStreamToken(),
    inject: [CLOCK, ROOT_LOGGER, { token: DB, optional: true }, { token: REDIS, optional: true }],
    useFactory: (
      clock: Clock,
      logger: RootLogger,
      db?: Kysely<Database>,
      redis?: RedisHandle,
    ): AgentStreamRuntime | null => {
      if (db == null) {
        logger.info('agent_stream_disabled');
        return null;
      }
      // Only called after PG's ownership check and committed cancellation. PG remains the
      // authority; the fast path carries no user data and never extends a run's lifetime.
      const cache = redis?.namespace('agent_cancel');
      const signals: AgentStreamRuntimeDeps['signals'] =
        cache === undefined
          ? undefined
          : {
              async requestCancel(runId) {
                await cache.set(runId, '1', Math.ceil(runTimingsDefaults().runMaxMs / 1_000));
                return 'ok';
              },
              async cancelRequested(runId) {
                return (await cache.get(runId)) === '1';
              },
            };
      return createAgentStreamRuntime({
        db,
        clock,
        logger,
        consentReader: options.consentReader,
        ...(signals === undefined ? {} : { signals }),
      });
    },
  };
}

export function createAgentStreamRuntime(
  deps: AgentStreamRuntimeDeps,
  seams?: AgentStreamSeams,
): AgentStreamRuntime {
  const { clock, logger } = deps;
  const db = deps.db.withSchema('app');
  const timings = Object.freeze(runTimingsDefaults());
  const runConfig = Object.freeze({ ...runConfigDefaults(), maxRunMs: timings.runMaxMs });
  assertRunTimings({ ...timings, admissionRunMaxMs: runConfig.maxRunMs, sweepMarginMs: 0 });
  const scheduler = seams?.schedule ?? systemScheduler();
  const texts = agentDefaultTexts();
  const reader = createContentReader({ db, clock });
  const switches = createAgentSwitchReader(db, clock, reader);
  const version = createConsentVersionSource({ reader, logger });
  // Platform and integration fixtures supply an app-scoped handle. Preserve that handle at
  // the cross-module factory boundary, as identity's public reader expects.
  const consent = deps.consentReader({ db: deps.db, currentVersion: version });
  const limits = createQuotaLimitsSource({ reader, logger });
  const pg = createPgRunPorts({
    db,
    clock,
    logger,
    timings,
    limits,
    texts,
    ...(deps.signals === undefined ? {} : { signals: deps.signals }),
  });
  const runs = createRunManager({
    admission: pg.admission,
    registry: pg.registry,
    clock,
    scheduler,
    config: runConfig,
    logger,
    texts: { ...texts, text: agentText },
    guard: { check: async () => ({ code: 30501 }) },
    guardFor: createRunGuardFactory({ reader: switches, consent, version }),
    cards: {
      async reserve(sessionId, count) {
        if (!Number.isSafeInteger(count) || count < 1) throw new RangeError('Invalid card count');
        const row = await db
          .updateTable('agent_sessions')
          .set({ card_seq: sql`card_seq + ${count}` })
          .where('id', '=', sessionId)
          .returning('card_seq')
          .executeTakeFirstOrThrow();
        return row.card_seq - count + 1;
      },
    },
  });
  const tools = seams?.tools ?? emptyOrchestratorTools();
  const runTexts: AgentRunTexts = {
    text: async (_appId, key) => agentText(key),
    // No model tools are registered in this mount.
    toolDisplay: async () => {
      throw new Error('No model tool display in this runtime');
    },
  };
  const route = async (): Promise<ResolvedRoute> => ({
    mode: 'no_model',
    attempts: [],
    dropped: [],
  });
  const prompt = { current: async () => null };
  const traceMask = (args: unknown, table: Readonly<Record<string, string>>): unknown =>
    maskForTrace(restorePlaceholders(args, table));
  const body = createAgentRunBody({
    tools,
    inputCheck: seams?.inputCheck ?? failClosedInputCheck(),
    degraded: createDegradedPath({
      tools,
      texts: runTexts,
      errorMsg: async (_appId, code) => texts.errorMsg(code),
    }),
    model: {
      complete: async () => {
        await route();
        return { kind: 'degraded', reason: 'route_no_model', attempts: [] };
      },
    },
    modelClock: () => createRunModelClock(timings.runMaxMs),
    review: { review: async () => 'timeout' },
    texts: runTexts,
    prompt,
    limits: orchestratorLimitsDefaults(),
    traceMask,
  });

  let stopping = false;
  let closing: Promise<void> | undefined;
  const active = new Set<Promise<void>>();
  const http = createAgentHttp({
    access: createAgentAccessPort({ reader: switches }),
    identity: createAgentIdentityPort({ reader: switches }),
    consent: createAgentConsentPort({ consent, version }),
    sessions: createPgAgentSessionStore({ db, clock, ...agentSessionDefaults() }),
    admission: {
      admit: (request, currentLimits) => {
        // A request already checking consent when shutdown starts cannot enter admission.
        if (stopping) return Promise.reject(new Error('Agent stream is stopping'));
        return pg.admission.admit(request, currentLimits);
      },
    },
    runs,
    cancel: pg.cancel,
    limits,
    body,
    redactor: createAgentRedactor(),
    labels: createRunLabels({
      route,
      prompt,
      // The fixed no_model route still needs a nonempty meta.model_label. An empty label
      // fails frame validation before meta is written or the body/settlement can run.
      modelLabel: async () => '未调用模型',
      aiLabel: async () => agentText('ai_label'),
    }),
    settings: agentHttpDefaults(),
    texts,
    ids: () => newUuidV7(clock.now()),
    clock,
    logger,
  });
  function tracked<T extends unknown[]>(
    operation: (...args: T) => Promise<void>,
    ...args: T
  ): Promise<void> {
    const task = operation(...args);
    active.add(task);
    void task.then(
      () => active.delete(task),
      () => active.delete(task),
    );
    return task;
  }
  return {
    timings,
    runConfig,
    limits,
    texts,
    traceMask,
    http: {
      ...http,
      sendMessage(caller, sessionId, message, reply) {
        if (stopping) {
          reply.json(
            500,
            { 'content-type': 'application/json' },
            {
              code: 50001,
              msg: texts.errorMsg(50001),
              trace_id: caller.traceId,
            },
          );
          return Promise.resolve();
        }
        return tracked(http.sendMessage, caller, sessionId, message, reply);
      },
    },
    close() {
      stopping = true;
      closing ??= (async () => {
        if (active.size === 0) return;
        const wait = new AbortController();
        try {
          await Promise.race([
            Promise.allSettled([...active]),
            scheduler.sleep(timings.runMaxMs + timings.lockGraceMs, wait.signal),
          ]);
        } finally {
          wait.abort();
        }
      })();
      return closing;
    },
  };
}
