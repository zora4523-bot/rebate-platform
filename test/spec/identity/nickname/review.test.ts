// B1-20d NicknameReviewPort implementations (no database): the local seed-list review, its word
// list loader, and the environment factory (fail-close in prod). The seed list is the module's
// data file infra/sensitive-words.nickname.txt (§9.4 D32); it must name SEED_WORD. Temporary
// lists go under .tmp/. Sources: 08 BR-ID-39, BR-AI-18 (fail-close); task brief §9.3 #6, §9.4.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, expect, it } from 'vitest';

const ROOT = new URL('../../../../', import.meta.url);
type ReviewModule =
  typeof import('../../../../apps/api/src/modules/identity/infra/nickname-review.ts');
const SEED_WORD = '赌博';
const base = fileURLToPath(new URL('.tmp/', ROOT));
mkdirSync(base, { recursive: true });
const dir = mkdtempSync(join(base, 'b1-20d-review-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function load(): Promise<ReviewModule> {
  return (await import(
    new URL('apps/api/src/modules/identity/infra/nickname-review.ts', ROOT).href
  )) as ReviewModule;
}

function listFile(name: string, text: string): URL {
  const path = join(dir, name);
  writeFileSync(path, text, 'utf8');
  return pathToFileURL(path);
}

/** The error a call throws, so that NotImplemented is never mistaken for the expected refusal. */
function thrown(call: () => unknown): Error {
  try {
    call();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to throw');
}

it('[AC-B1-20d#16] 种子词表读取：每行一词、跳过空行与 # 注释；缺文件或没有词 → 抛错（不是 NotImplemented）', async () => {
  const { loadNicknameSensitiveWords } = await load();
  const words = loadNicknameSensitiveWords(
    listFile('ok.txt', '# nickname seed\n\n  甲词  \r\nBadWord\n# 注释\n'),
  );
  expect(words).toEqual(['甲词', 'BadWord']);
  for (const file of [
    listFile('empty.txt', ''),
    listFile('comments.txt', '# only\n\n   \n# comments\n'),
    pathToFileURL(join(dir, 'missing.txt')),
  ]) {
    const error = thrown(() => loadNicknameSensitiveWords(file));
    expect(error.message).not.toMatch(/NotImplemented/);
  }
});

it('[AC-B1-20d#16] 模块自带种子词表存在、非空并含测试用词', async () => {
  const { loadNicknameSensitiveWords } = await load();
  const words = loadNicknameSensitiveWords();
  expect(words.length).toBeGreaterThan(0);
  expect(words).toContain(SEED_WORD);
});

it('[AC-B1-20d#16] 本地审核：含词（不区分大小写的子串）→ hit，否则 pass', async () => {
  const { createLocalNicknameReview } = await load();
  const review = createLocalNicknameReview(['甲词', 'BadWord']);
  expect(await review.review({ appId: 'app_a', text: '小狸甲词' })).toBe('hit');
  expect(await review.review({ appId: 'app_a', text: 'xxbadwordxx' })).toBe('hit');
  expect(await review.review({ appId: 'app_a', text: 'BADWORD' })).toBe('hit');
  expect(await review.review({ appId: 'app_a', text: '小狸' })).toBe('pass');
  expect(await review.review({ appId: 'app_a', text: 'Bad Word' })).toBe('pass');
});

for (const env of ['local', 'test', 'staging'] as const) {
  it(`[AC-B1-20d#6] ${env} 环境用本地种子词表审核：含 ${SEED_WORD} → hit，普通昵称 → pass`, async () => {
    const { createNicknameReview } = await load();
    const review = createNicknameReview(env);
    expect(await review.review({ appId: 'app_a', text: `小狸${SEED_WORD}` })).toBe('hit');
    expect(await review.review({ appId: 'app_a', text: '小狸' })).toBe('pass');
  });
}

it('[AC-B1-20d#6] prod 环境恒 fail-close：普通昵称与含词昵称都返回 unavailable', async () => {
  const { createNicknameReview } = await load();
  const review = createNicknameReview('prod');
  expect(await review.review({ appId: 'app_a', text: '小狸' })).toBe('unavailable');
  expect(await review.review({ appId: 'app_a', text: `小狸${SEED_WORD}` })).toBe('unavailable');
});
