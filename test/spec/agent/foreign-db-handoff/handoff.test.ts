// B3-08k · BR-AI-02 ③ (D10-294; spec-test review r1 S1-1, S1-2, S2; r2 S1, S2, D10-305): agent
// never takes its database handle to a function it does not own. Static scan over a TypeScript
// program of apps/api/src/modules/agent/** (test files excluded; rules in ./scan.ts): no database
// handle, as written or carried by an argument (a get accessor included), reaches an external
// callee — another module's function or class, or any function value handed in from outside (a
// parameter, an options / deps property, an injected token value), whatever agent type it is
// declared with; kysely / @couli/db API and agent's or platform's own functions with a body may
// take it. One narrow exception: the business assembly app.module hands agent as its `assembly`
// option, when the scan proves it resolves to agent's own function with a body — then the slots of
// that option's type (`deps.assembly`, the provider's `options.assembly`) count as agent's own.
// The scan proves itself first on in-memory samples (violating and allowed: the old caller.ts
// readerFactory({db}) and index.ts consentReader({db}) shapes, own and foreign assemblies among
// them), then runs on the code. The composition root (app.module) assembles agent's readers and
// provides them by token, hands agent an assembly declared in agent, and the reads afresh it hands
// agent (freshConfigValue) build a content reader per call.
import { dirname, join, relative, sep } from 'node:path';
import { expect, it } from 'vitest';
import {
  AGENT,
  APP_MODULE,
  MODULES,
  ROOT,
  TASK_FILES,
  agentSourcePaths,
  assemblyHandoffs,
  calledNames,
  foreignDbHandoffs,
  forStreamOptionNames,
  freshConfigValueMembers,
  scanProgram,
  type SourceText,
} from './scan.ts';

const SAMPLE_DIR = join(AGENT, 'stream/mount');
let sampleNo = 0;

function sample(text: string): SourceText {
  sampleNo += 1;
  return { path: join(SAMPLE_DIR, `__b3_08k_sample_${String(sampleNo)}__.ts`), text };
}

/** Another module's file, in memory only (the scan reads only agent's files). */
const FOREIGN: SourceText = {
  path: join(MODULES, 'identity/__b3_08k_sample__.ts'),
  text: [
    "import type { DB } from '@couli/db';",
    "import type { Kysely } from 'kysely';",
    'export type SampleCallerReaderFactory = (options: {',
    '  readonly db: Kysely<DB>;',
    '}) => { deviceHash(appId: string, deviceId: string): Promise<string | null> };',
    'export class SampleReader {',
    '  constructor(db: Kysely<DB>) {',
    '    void db;',
    '  }',
    '}',
    'export function sampleWrite(trx: Kysely<DB>): void {',
    '  void trx;',
    '}',
    'export function sampleRead(options: { readonly clock: unknown; readonly logger: unknown }) {',
    '  void options;',
    '}',
    'export function sampleForeignAssembly(context: { readonly db: Kysely<DB> }): unknown {',
    '  return context.db;',
    '}',
  ].join('\n'),
};

/** platform's database infrastructure, in memory only (D10-287: not another module). */
const PLATFORM: SourceText = {
  path: join(MODULES, 'platform/__b3_08k_sample__.ts'),
  text: [
    "import type { DB } from '@couli/db';",
    "import type { Kysely } from 'kysely';",
    'export function sampleAppSchema(db: Kysely<DB>): Kysely<DB> {',
    "  return db.withSchema('app');",
    '}',
    'export function sampleAssembly(context: { readonly db: Kysely<DB> }): unknown {',
    '  return context.db;',
    '}',
  ].join('\n'),
};

const HEAD = [
  "import type { DB } from '@couli/db';",
  "import type { Kysely } from 'kysely';",
  "import type { Clock, RootLogger } from '../../../platform/index.ts';",
].join('\n');

/** The import specifier of an agent sample from another agent sample. */
function local(file: SourceText): string {
  return `./${file.path.slice(SAMPLE_DIR.length + 1)}`;
}

/** A sample re-exporting content's factory under another name, imported by a later sample. */
const RELAY = sample(
  "export { createContentReader as makeReader } from '../../../content/index.ts';",
);

/**
 * Review r2 (D10-305): two assembly options of agent with their own type aliases, as
 * AgentModule.forStream's `assembly`. The composition sample below hands the "own" option only
 * agent's function with a body (so its alias is proven) and the "foreign" option other values.
 */
const SLOTS = sample(
  `${HEAD}
export interface SampleContext {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
}
export type SampleOwnAssemblyFactory = (context: SampleContext) => unknown;
export type SampleForeignAssemblyFactory = (context: SampleContext) => unknown;
export interface SampleOwnOptions {
  readonly assembly?: SampleOwnAssemblyFactory;
  readonly safety?: string;
}
export interface SampleForeignOptions {
  readonly assembly?: SampleForeignAssemblyFactory;
}
export function sampleOwnForStream(options: SampleOwnOptions): SampleOwnOptions {
  return options;
}
export function sampleForeignForStream(options: SampleForeignOptions): SampleForeignOptions {
  return options;
}
export function sampleOwnAssembly(context: SampleContext): unknown {
  return context.clock;
}
export declare function sampleDeclaredAssembly(context: SampleContext): unknown;`,
);

/** agent's assembly re-exported under another name, as agent/index.ts re-exports production's. */
const RELAY_OWN = sample(`export { sampleOwnAssembly as ownAssembly } from '${local(SLOTS)}';`);

/** The composition root of the samples (outside every module, as app.module), in memory only. */
const COMPOSITION_PATH = join(ROOT, 'apps/api/src/__b3_08k_sample_root__.ts');
const fromRoot = (file: SourceText): string =>
  `./${relative(dirname(COMPOSITION_PATH), file.path).split(sep).join('/')}`;
const COMPOSITION: SourceText = {
  path: COMPOSITION_PATH,
  text: `import { sampleForeignAssembly } from './modules/identity/__b3_08k_sample__.ts';
import { sampleAssembly } from './modules/platform/__b3_08k_sample__.ts';
import {
  sampleDeclaredAssembly,
  sampleForeignForStream,
  sampleOwnForStream,
} from '${fromRoot(SLOTS)}';
import { ownAssembly } from '${fromRoot(RELAY_OWN)}';
export const modules = [
  sampleOwnForStream({ assembly: ownAssembly, safety: 'on' }),
  sampleForeignForStream({ assembly: sampleForeignAssembly }),
  sampleForeignForStream({ assembly: sampleAssembly }),
  sampleForeignForStream({ assembly: sampleDeclaredAssembly }),
  sampleForeignForStream({ assembly: (context) => sampleForeignAssembly(context) }),
];`,
};

const VIOLATING: SourceText[] = [
  sample(
    `${HEAD}
import { createContentReader } from '../../../content/index.ts';
export function f(db: Kysely<DB>, clock: Clock) {
  return createContentReader({ db, clock });
}`,
  ),
  sample(
    `${HEAD}
import { createContentReader } from '../../../content/index.ts';
export function f(db: Kysely<DB>, clock: Clock) {
  return createContentReader({ db: db.withSchema('app'), clock });
}`,
  ),
  sample(
    `${HEAD}
import type { SampleCallerReaderFactory } from '../../../identity/__b3_08k_sample__.ts';
export function f(readerFactory: SampleCallerReaderFactory, db: Kysely<DB>) {
  return readerFactory({ db });
}`,
  ),
  sample(
    `${HEAD}
import { SampleReader } from '../../../identity/__b3_08k_sample__.ts';
export function f(db: Kysely<DB>) {
  return new SampleReader(db);
}`,
  ),
  sample(
    `${HEAD}
import { sampleWrite } from '../../../identity/__b3_08k_sample__.ts';
export async function f(db: Kysely<DB>) {
  await db.transaction().execute(async (trx) => sampleWrite(trx));
}`,
  ),
  // A handle under another name, recognised by its type.
  sample(
    `${HEAD}
import { createContentReader } from '../../../content/index.ts';
export function f(primary: Kysely<DB>, clock: Clock) {
  const handle = primary.withSchema('app');
  return createContentReader({ db: handle, clock });
}`,
  ),
  // A handle reached through a property, and a namespace import.
  sample(
    `${HEAD}
import * as content from '../../../content/index.ts';
export function f(deps: { readonly db: Kysely<DB>; readonly clock: Clock }) {
  return content.createContentReader({ db: deps.db, clock: deps.clock });
}`,
  ),
  // Another module's factory re-exported by an agent file under another name.
  sample(
    `${HEAD}
import { makeReader } from './${RELAY.path.slice(SAMPLE_DIR.length + 1)}';
export function f(db: Kysely<DB>, clock: Clock) {
  return makeReader({ db, clock });
}`,
  ),
  // S1-1, the old caller.ts: a reader factory typed in agent, handed in through the module
  // options, fed agent's handle.
  sample(
    `${HEAD}
type CallerReaderFactory = (options: { db: Kysely<DB> }) => {
  deviceHash(appId: string, deviceId: string): Promise<string | null>;
};
export function callerProvider(readerFactory: CallerReaderFactory) {
  return {
    useFactory: (db?: Kysely<DB>) =>
      db === undefined ? null : readerFactory({ db: db.withSchema('app') }),
  };
}`,
  ),
  // S1-1, the old index.ts consent reader: a deps property typed in agent, fed agent's handle.
  sample(
    `${HEAD}
interface Deps {
  readonly db: Kysely<DB>;
  readonly consentReader: (options: {
    readonly db: Kysely<DB>;
    readonly currentVersion: (appId: string) => Promise<number>;
  }) => unknown;
}
export function f(deps: Deps, version: (appId: string) => Promise<number>) {
  return deps.consentReader({ db: deps.db, currentVersion: version });
}`,
  ),
  // S1-1: an injected token value (a factory provider's argument) fed the injected handle.
  sample(
    `${HEAD}
import { DB as DB_TOKEN } from '../../../platform/index.ts';
const READER = Symbol('B3_08K_SAMPLE_READER');
export const provider = {
  provide: Symbol('B3_08K_SAMPLE'),
  inject: [DB_TOKEN, READER],
  useFactory: (db: Kysely<DB>, build: (handle: Kysely<DB>) => unknown) => build(db),
};`,
  ),
  // S1-1: a local alias of another module's function.
  sample(
    `${HEAD}
import { createContentReader } from '../../../content/index.ts';
const make = createContentReader;
export function f(db: Kysely<DB>, clock: Clock) {
  return make({ db, clock });
}`,
  ),
  // S2: a variable object holding the handle.
  sample(
    `${HEAD}
import { createContentReader } from '../../../content/index.ts';
export function f(db: Kysely<DB>, clock: Clock) {
  const options = { db, clock };
  return createContentReader(options);
}`,
  ),
  // S2: deps with a db field, passed whole.
  sample(
    `${HEAD}
import { createContentReader } from '../../../content/index.ts';
export function f(deps: { readonly db: Kysely<DB>; readonly clock: Clock; readonly n: number }) {
  return createContentReader(deps);
}`,
  ),
  // S2: deps spread into the argument.
  sample(
    `${HEAD}
import { createContentReader } from '../../../content/index.ts';
export function f(deps: { readonly db: Kysely<DB>; readonly clock: Clock }) {
  return createContentReader({ ...deps });
}`,
  ),
  // S2: through Function.prototype.call.
  sample(
    `${HEAD}
import { createContentReader } from '../../../content/index.ts';
export function f(db: Kysely<DB>, clock: Clock) {
  return createContentReader.call(null, { db, clock });
}`,
  ),
  // S2: a handle typed any, recognised by its name (a field db, a parameter tx).
  sample(
    `${HEAD}
import { createContentReader } from '../../../content/index.ts';
import { sampleWrite } from '../../../identity/__b3_08k_sample__.ts';
export function f(deps: { readonly db: any; readonly clock: Clock }) {
  return createContentReader(deps);
}
export function g(tx: any) {
  sampleWrite(tx);
}`,
  ),
  // S2: a spread argument list carrying the handle.
  sample(
    `${HEAD}
import { sampleWrite } from '../../../identity/__b3_08k_sample__.ts';
export function f(db: Kysely<DB>) {
  const args = [db] as const;
  sampleWrite(...args);
}`,
  ),
  // Review r2 S2: a get accessor hands over what it returns.
  sample(
    `${HEAD}
import { createContentReader } from '../../../content/index.ts';
export function f(db: Kysely<DB>, clock: Clock) {
  return createContentReader({
    get db() {
      return db.withSchema('app');
    },
    clock,
  });
}`,
  ),
  // Review r2 S1: the runtime / provider shape over an assembly option that is not proven agent's
  // own (the composition hands it another module's, platform's, a declared-only or an in-place
  // function).
  sample(
    `${HEAD}
import type {
  SampleContext,
  SampleForeignAssemblyFactory,
  SampleForeignOptions,
} from '${local(SLOTS)}';
export function runtime(deps: {
  readonly assembly?: SampleForeignAssemblyFactory;
  readonly db: Kysely<DB>;
  readonly clock: Clock;
}) {
  return deps.assembly?.({ db: deps.db, clock: deps.clock });
}
export function provider(options: Pick<SampleForeignOptions, 'assembly'>) {
  const factory = options.assembly;
  return factory === undefined ? undefined : (context: SampleContext) => factory({ ...context });
}`,
  ),
  // Review r2 S1: a proven assembly slot excuses nothing else — the caller / consent reader shape
  // beside it is still external.
  sample(
    `${HEAD}
import type { SampleOwnAssemblyFactory } from '${local(SLOTS)}';
export function runtime(deps: {
  readonly assembly?: SampleOwnAssemblyFactory;
  readonly consentReader: (options: { readonly db: Kysely<DB> }) => unknown;
  readonly db: Kysely<DB>;
  readonly clock: Clock;
}) {
  deps.assembly?.({ db: deps.db, clock: deps.clock });
  return deps.consentReader({ db: deps.db });
}`,
  ),
  // Review r2 S1: a variable typed with the proven alias is judged by the value it holds.
  sample(
    `${HEAD}
import { sampleForeignAssembly } from '../../../identity/__b3_08k_sample__.ts';
import type { SampleOwnAssemblyFactory } from '${local(SLOTS)}';
export function f(db: Kysely<DB>, clock: Clock) {
  const build: SampleOwnAssemblyFactory = sampleForeignAssembly;
  return build({ db, clock });
}`,
  ),
];

const ALLOWED: SourceText[] = [
  // agent's own functions may take the handle.
  sample(
    `${HEAD}
import { createPgResultSetStore } from '../../store/results/index.ts';
function local(handle: Kysely<DB>): Kysely<DB> {
  return handle;
}
export function f(db: Kysely<DB>) {
  local(db);
  return createPgResultSetStore({ db });
}`,
  ),
  // Another module's functions without a handle: clock, logger, strings, dates.
  sample(
    `${HEAD}
import { switchSpecOf } from '../../../content/index.ts';
import { newUuidV7 } from '../../../platform/index.ts';
import { sampleRead } from '../../../identity/__b3_08k_sample__.ts';
export function f(clock: Clock, logger: RootLogger, key: string) {
  sampleRead({ clock, logger });
  sampleRead({
    get clock() {
      return clock;
    },
    logger,
  });
  switchSpecOf(key);
  return newUuidV7(clock.now());
}`,
  ),
  // An injected reader (content's interface type) and kysely's own functions.
  sample(
    `${HEAD}
import { sql } from 'kysely';
import type { ContentReader } from '../../../content/index.ts';
export async function f(reader: Pick<ContentReader, 'configValue'>, db: Kysely<DB>, app: string) {
  await sql\`SELECT 1\`.execute(db);
  return reader.configValue(app, 'agent.enabled');
}`,
  ),
  RELAY,
  // S1-1: agent's own functions with a body of every shape, reading and writing agent_* tables
  // over the handle (declaration, arrow, class, object property, .call, in place, a transaction).
  sample(
    `${HEAD}
import { sql } from 'kysely';
function dropCard(handle: Kysely<DB>, id: string) {
  return handle.deleteFrom('agent_cards').where('id', '=', id).execute();
}
const runIds = async (handle: Kysely<DB>, sessionId: string) =>
  handle.selectFrom('agent_runs').select('id').where('session_id', '=', sessionId).execute();
class SessionReader {
  readonly #db: Kysely<DB>;
  constructor(db: Kysely<DB>) {
    this.#db = db;
  }
  ids(sessionId: string) {
    return runIds(this.#db, sessionId);
  }
}
const own = { dropCard, runs: runIds };
export async function f(db: Kysely<DB>, id: string) {
  await dropCard(db, id);
  await runIds(db.withSchema('app'), id);
  await new SessionReader(db).ids(id);
  await own.dropCard(db, id);
  await own.runs(db, id);
  await dropCard.call(null, db, id);
  await (async (handle: Kysely<DB>) => handle.selectFrom('agent_sessions').select('id').execute())(
    db,
  );
  await db.transaction().execute(async (trx) => {
    await sql\`SELECT 1\`.execute(trx);
    await dropCard(trx, id);
  });
}`,
  ),
  // S2: platform's database infrastructure is not another module (D10-287).
  sample(
    `${HEAD}
import { createPgResultSetStore } from '../../store/results/index.ts';
import { sampleAppSchema } from '../../../platform/__b3_08k_sample__.ts';
export function f(db: Kysely<DB>) {
  return createPgResultSetStore({ db: sampleAppSchema(db) });
}`,
  ),
  // S2: variables, spreads and rests without a handle may go anywhere.
  sample(
    `${HEAD}
import { createPgResultSetStore } from '../../store/results/index.ts';
import { sampleRead } from '../../../identity/__b3_08k_sample__.ts';
export function f(deps: { readonly db: Kysely<DB>; readonly clock: Clock; readonly logger: RootLogger }) {
  const { db, ...rest } = deps;
  sampleRead(rest);
  sampleRead({ ...rest });
  return createPgResultSetStore({ db });
}`,
  ),
  SLOTS,
  RELAY_OWN,
  // Review r2 S1 (D10-305): the runtime / provider shape over the assembly option the composition
  // proves agent's own: the context may carry the handle, as a field or spread.
  sample(
    `${HEAD}
import type { SampleContext, SampleOwnAssemblyFactory, SampleOwnOptions } from '${local(SLOTS)}';
export function runtime(deps: {
  readonly assembly?: SampleOwnAssemblyFactory;
  readonly db: Kysely<DB>;
  readonly clock: Clock;
}) {
  return deps.assembly?.({ db: deps.db, clock: deps.clock });
}
export function provider(options: Pick<SampleOwnOptions, 'assembly' | 'safety'>) {
  const factory = options.assembly;
  return factory === undefined ? undefined : (context: SampleContext) => factory({ ...context });
}`,
  ),
];

const MEMORY = [...VIOLATING, ...ALLOWED, FOREIGN, PLATFORM, COMPOSITION];
let built: ReturnType<typeof scanProgram> | undefined;

/**
 * One program for this file: agent's files and app.module (with everything they import) from the
 * disk, the samples from memory (never written to disk).
 */
function program(): ReturnType<typeof scanProgram> {
  built ??= scanProgram(
    [...agentSourcePaths(), APP_MODULE, ...MEMORY.map((file) => file.path)],
    MEMORY,
  );
  return built;
}

it('[AC-B3-08k#1][BR-AI-02] agent/** 不把数据库句柄（db / trx / tx、.withSchema(…)、Kysely / Transaction 类型；照写或由实参、展开、变量对象、get 访问器携带）交给外部被调用者（别模块的函数或类、参数 / 选项属性 / 注入令牌值等外部交入的函数值；kysely、@couli/db 与 agent / platform 自有带函数体的函数除外；app.module 交入且经 AST 证明解析到 agent 内带函数体声明的 assembly，其选项类型的槽位视为 agent 自有）；扫描先用内存样例自证（违规与合法各一组，含改前 caller.ts 与 index.ts 两处写法、自有与外来 assembly），主干零违规', () => {
  const paths = agentSourcePaths();
  expect(paths).toEqual(expect.arrayContaining(TASK_FILES));
  const scan = program();

  // Which assembly the sample composition proves agent's own: only agent's function with a body,
  // reached through a re-export under another name.
  const proven = assemblyHandoffs(scan, [COMPOSITION.path]).map((handoff) => [
    handoff.value,
    handoff.problem === null,
  ]);
  expect(proven).toEqual([
    ['ownAssembly', true],
    ['sampleForeignAssembly', false],
    ['sampleAssembly', false],
    ['sampleDeclaredAssembly', false],
    ['(context) => sampleForeignAssembly(context)', false],
  ]);

  // The scan itself, on the in-memory samples (the foreign, platform and composition files are
  // never scanned), with the sample composition as the one proving the assembly slots.
  const compositions = [COMPOSITION.path];
  for (const file of VIOLATING) {
    expect(foreignDbHandoffs(scan, [file.path], compositions).length, file.text).toBeGreaterThan(0);
  }
  for (const file of ALLOWED) {
    expect(foreignDbHandoffs(scan, [file.path], compositions), file.text).toEqual([]);
  }

  // agent's code, with app.module as the composition root.
  expect(foreignDbHandoffs(scan, paths, [APP_MODULE])).toEqual([]);
}, 180_000);

it('[AC-B3-08k#1][AC-B3-08k#5][BR-AI-02] 组装根 app.module 交给 agent 的 assembly 经 import / 再导出解析到 apps/api/src/modules/agent/ 内带函数体的声明；app.module 组装 agent 要的读取器并按令牌提供：调用 agentContentReaderToken()、agentCallerReaderToken() 与 agentConsentReaderToken()，自己调用 createContentReader、identity 的 createAgentCallerReader 与 createAiConsentReader；AgentModule.forStream 的选项不再带 callerReader、consentReader', () => {
  const assemblies = assemblyHandoffs(program(), [APP_MODULE]);
  expect(assemblies.length, 'assembly options app.module hands agent').toBeGreaterThan(0);
  expect(assemblies.filter((handoff) => handoff.problem !== null)).toEqual([]);

  const called = calledNames(APP_MODULE);
  expect(called.has('agentContentReaderToken'), 'app.module provides the content reads').toBe(true);
  expect(called.has('agentCallerReaderToken'), 'app.module provides the caller reader').toBe(true);
  expect(called.has('agentConsentReaderToken'), 'app.module provides the consent reader').toBe(
    true,
  );
  expect(called.has('createContentReader')).toBe(true);
  expect(called.has('createAgentCallerReader'), 'app.module builds the caller reader').toBe(true);
  expect(called.has('createAiConsentReader'), 'app.module builds the consent reader').toBe(true);
  const options = forStreamOptionNames(APP_MODULE);
  expect(options.length, 'AgentModule.forStream calls').toBeGreaterThan(0);
  for (const names of options) {
    expect(names).not.toContain('callerReader');
    expect(names).not.toContain('consentReader');
  }
}, 180_000);

it('[AC-B3-08k#4][BR-AI-02] app.module 交给 agent 的 freshConfigValue 不经缓存：每个都是就地写的函数，答案是每次新建的 createContentReader(…).configValue(…)（与改前 createAgentSwitchReader 每次新建读取器同一读法），不指向共享读取器、外部变量或缓存', () => {
  const members = freshConfigValueMembers(APP_MODULE);
  expect(members.length, 'freshConfigValue members in app.module').toBeGreaterThan(0);
  expect(members.filter((member) => member.problem !== null)).toEqual([]);
});
