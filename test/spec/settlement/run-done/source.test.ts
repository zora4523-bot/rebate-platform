// B2-04zf (D10-492 ⑥): the code under test never reads event_log. 02 §11: event_log is the audit
// copy of the outbox, not a delivery mechanism, and no consumer reads it; the part and outcome of
// a run come from settlement's own app.settle_runs. Text check over the task's source paths
// (apps/api/src/modules/settlement/batch/** and the module's index.ts, *.test.ts left out):
//   - after line and block comments are removed, no file names event_log (a comment may, e.g. to
//     explain why it is not read);
//   - some file under batch/** names settle_runs outside comments (where part and outcome live).
// Comments are removed naively (`//` to the end of the line, `/* … */`), so a `//` inside a string
// cuts the rest of that line too; this only ever hides text, never adds any.
import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const MODULE = new URL('../../../../apps/api/src/modules/settlement/', import.meta.url);
const BATCH = new URL('batch/', MODULE);

interface Source {
  readonly path: string;
  readonly code: string;
}

/** The source without its comments. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function read(path: string, url: URL): Source {
  return { path, code: withoutComments(readFileSync(url, 'utf8')) };
}

/** Every non-test .ts file under batch/**, by its path below the module. */
function batchSources(): Source[] {
  return readdirSync(BATCH, { encoding: 'utf8', recursive: true })
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort()
    .map((name) => read(`batch/${name}`, new URL(name, BATCH)));
}

it('[AC-B2-04zf#30] settlement batch 源码（batch/** 与模块 index.ts，不含 *.test.ts）去掉注释后不出现 event_log；part 与 outcome 经 settlement 自有的 settle_runs（batch/** 里有代码引用 settle_runs）', () => {
  const batch = batchSources();
  expect(batch.length).toBeGreaterThan(0);
  const all = [...batch, read('index.ts', new URL('index.ts', MODULE))];

  expect(all.filter((s) => /event_log/.test(s.code)).map((s) => s.path)).toEqual([]);
  expect(batch.filter((s) => /settle_runs/.test(s.code)).map((s) => s.path)).not.toEqual([]);
});
