// B3-08k · BR-AI-02 ③ (D10-294): agent never takes its database handle to build another module's
// reader. Static scan over a TypeScript program of apps/api/src/modules/agent/** (test files
// excluded; rules in ./scan.ts): no database handle reaches a function or class constructor that
// comes from another module, neither as an argument nor as an object literal property value. The
// scan proves itself first on in-memory samples (violating and allowed), then runs on the code.
// The composition root (app.module) assembles agent's readers and provides them by token.
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
];

it('[AC-B3-08k#1][BR-AI-02] agent/** 不把数据库句柄（db / trx / tx、.withSchema(…)、Kysely / Transaction 类型）作为实参或对象字面量属性值交给别模块的函数或类构造器；扫描先用内存样例自证（违规与合法各一组），主干零违规', () => {
  const paths = agentSourcePaths();
  expect(paths).toEqual(expect.arrayContaining(TASK_FILES));
  // One program: agent's files from the disk, the samples from memory (never written to disk).
  const memory = [...VIOLATING, ...ALLOWED, FOREIGN];
  const program = scanProgram([...paths, ...memory.map((file) => file.path)], memory);

  // The scan itself, on the in-memory samples (the foreign file is never scanned).
  for (const file of VIOLATING) {
    expect(foreignDbHandoffs(program, [file.path]).length, file.text).toBeGreaterThan(0);
  }
  for (const file of ALLOWED) {
    expect(foreignDbHandoffs(program, [file.path]), file.text).toEqual([]);
  }

  // agent's code.
  expect(foreignDbHandoffs(program, paths)).toEqual([]);
}, 180_000);

it('[AC-B3-08k#1][BR-AI-02] 组装根 app.module 组装 agent 要的读取器并按令牌提供：调用 agentContentReaderToken() 与 agentCallerReaderToken()，自己调用 createContentReader 与 identity 的 createAgentCallerReader；AgentModule.forStream 的选项不再带 callerReader 工厂', () => {
  const called = calledNames(APP_MODULE);
  expect(called.has('agentContentReaderToken'), 'app.module provides the content reads').toBe(true);
  expect(called.has('agentCallerReaderToken'), 'app.module provides the caller reader').toBe(true);
  expect(called.has('createContentReader')).toBe(true);
  expect(called.has('createAgentCallerReader'), 'app.module builds the caller reader').toBe(true);
  const options = forStreamOptionNames(APP_MODULE);
  expect(options.length, 'AgentModule.forStream calls').toBeGreaterThan(0);
  for (const names of options) expect(names).not.toContain('callerReader');
});
