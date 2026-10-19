import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import {
  LEDGER_INVARIANT_DIRECTORY,
  directoryInvariantSource,
  parseSupersededManifest,
} from './invariant-files.ts';

const ROOT = new URL('../../../../../../.tmp/b2-02j-invariant-files/', import.meta.url);
const created: string[] = [];

async function fixture(files: Record<string, string>): Promise<URL> {
  await mkdir(ROOT, { recursive: true });
  const path = await mkdtemp(fileURLToPath(new URL('case-', ROOT)));
  created.push(path);
  for (const [name, text] of Object.entries(files)) await writeFile(`${path}/${name}`, text);
  return pathToFileURL(`${path}/`);
}

afterEach(async () => {
  for (const path of created.splice(0)) await rm(path, { recursive: true, force: true });
});

it('[AC-B2-02j-UNIT#6] 默认目录指向仓库 db/invariants/ledger/', () => {
  expect(LEDGER_INVARIANT_DIRECTORY.href.endsWith('/db/invariants/ledger/')).toBe(true);
});

it('[AC-B2-02j-UNIT#7] 只取 *.sql；superseded.json 所列 file 被跳过；无清单时全取', async () => {
  const withManifest = await fixture({
    '01_a.sql': 'SELECT 1',
    '03_old.sql': 'SELECT 3',
    '03_new.sql': 'SELECT 33',
    'README.md': 'x',
    'superseded.json': JSON.stringify([
      { file: '03_old.sql', replaced_by: '03_new.sql', reason: 'r' },
    ]),
  });
  const names = (await directoryInvariantSource(withManifest).load()).map((f) => f.name).sort();
  expect(names).toEqual(['01_a.sql', '03_new.sql']);
  const without = await fixture({ '02_b.sql': 'SELECT 2', 'x.txt': '' });
  expect(await directoryInvariantSource(without).load()).toEqual([
    { name: '02_b.sql', sql: 'SELECT 2' },
  ]);
});

it('[AC-B2-02j-UNIT#8] superseded.json 不是对象数组或缺 file 时报错，不静默忽略', async () => {
  for (const document of [{}, ['03_old.sql'], [null], [{ replaced_by: 'x' }], [{ file: 3 }]]) {
    expect(() => parseSupersededManifest(document)).toThrow();
  }
  expect([...parseSupersededManifest([{ file: 'a.sql' }])]).toEqual(['a.sql']);
  const broken = await fixture({ '01_a.sql': 'SELECT 1', 'superseded.json': '{"file":1}' });
  await expect(directoryInvariantSource(broken).load()).rejects.toThrow();
});
