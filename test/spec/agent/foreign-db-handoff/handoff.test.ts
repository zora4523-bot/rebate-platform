// B3-08k · BR-AI-02 ③ (D10-294; spec-test review r1 S1-1, S1-2, S2): agent never takes its
// database handle to a function it does not own. Static scan over a TypeScript program of
// apps/api/src/modules/agent/** (test files excluded; rules in ./scan.ts): no database handle, as
// written or carried by an argument, reaches an external callee — another module's function or
// class, or any function value handed in from outside (a parameter, an options / deps property,
// an injected token value), whatever agent type it is declared with; kysely / @couli/db API and
// agent's or platform's own functions with a body may take it. The scan proves itself first on
// in-memory samples (violating and allowed: the old caller.ts readerFactory({db}) and index.ts
// consentReader({db}) shapes among them), then runs on the code. The composition root (app.module)
// assembles agent's readers and provides them by token; the reads afresh it hands agent
// (freshConfigValue) build a content reader per call.
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  AGENT,
  APP_MODULE,
  MODULES,
  TASK_FILES,
  agentSourcePaths,
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
  ].join('\n'),
};

const HEAD = [
  "import type { DB } from '@couli/db';",
  "import type { Kysely } from 'kysely';",
  "import type { Clock, RootLogger } from '../../../platform/index.ts';",
].join('\n');

/** A sample re-exporting content's factory under another name, imported by a later sample. */
const RELAY = sample(
  "export { createContentReader as makeReader } from '../../../content/index.ts';",
);

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
];

it('[AC-B3-08k#1][BR-AI-02] agent/** 不把数据库句柄（db / trx / tx、.withSchema(…)、Kysely / Transaction 类型；照写或由实参、展开、变量对象携带）交给外部被调用者（别模块的函数或类、参数 / 选项属性 / 注入令牌值等外部交入的函数值；kysely、@couli/db 与 agent / platform 自有带函数体的函数除外）；扫描先用内存样例自证（违规与合法各一组，含改前 caller.ts 与 index.ts 两处写法），主干零违规', () => {
  const paths = agentSourcePaths();
  expect(paths).toEqual(expect.arrayContaining(TASK_FILES));
  // One program: agent's files from the disk, the samples from memory (never written to disk).
  const memory = [...VIOLATING, ...ALLOWED, FOREIGN, PLATFORM];
  const program = scanProgram([...paths, ...memory.map((file) => file.path)], memory);

  // The scan itself, on the in-memory samples (the foreign and platform files are never scanned).
  for (const file of VIOLATING) {
    expect(foreignDbHandoffs(program, [file.path]).length, file.text).toBeGreaterThan(0);
  }
  for (const file of ALLOWED) {
    expect(foreignDbHandoffs(program, [file.path]), file.text).toEqual([]);
  }

  // agent's code.
  expect(foreignDbHandoffs(program, paths)).toEqual([]);
}, 180_000);

it('[AC-B3-08k#1][AC-B3-08k#5][BR-AI-02] 组装根 app.module 组装 agent 要的读取器并按令牌提供：调用 agentContentReaderToken()、agentCallerReaderToken() 与 agentConsentReaderToken()，自己调用 createContentReader、identity 的 createAgentCallerReader 与 createAiConsentReader；AgentModule.forStream 的选项不再带 callerReader、consentReader', () => {
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
});

it('[AC-B3-08k#4][BR-AI-02] app.module 交给 agent 的 freshConfigValue 不经缓存：每个都是就地写的函数，答案是每次新建的 createContentReader(…).configValue(…)（与改前 createAgentSwitchReader 每次新建读取器同一读法），不指向共享读取器、外部变量或缓存', () => {
  const members = freshConfigValueMembers(APP_MODULE);
  expect(members.length, 'freshConfigValue members in app.module').toBeGreaterThan(0);
  expect(members.filter((member) => member.problem !== null)).toEqual([]);
});
