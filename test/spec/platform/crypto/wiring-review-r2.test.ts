// Rule tests added after the second rule-test review of B1-01k (规划/08 BR-ID-33「身份证号、收款账号、
// 手机号…日志…中不得出现明文」; §4 and §6 of apps/api/src/modules/platform/config/keyring-startup.ts:
// the injected FIELD_CRYPTO is the very object of openFieldCrypto, and nothing logs a value).
// Every entry is started with an in-memory logger at level trace; the injected cipher then
// encrypts, decrypts, re-encrypts, blind-indexes and reads key versions of the synthetic phone
// number, id number, payout accounts and payee name. No log line written while the entry started,
// ran these calls or closed may carry any of them (nor a key or a path). A wrapper that logs the
// value before handing it on — at any level — turns these red. Top-level it() only.
import { afterAll, expect, it } from 'vitest';
import { loadConfig } from '../../../../apps/api/src/modules/platform/config/index.ts';
import type { FieldCrypto } from '../../../../apps/api/src/modules/platform/crypto/index.ts';
import { leaksIn, referenceEncrypt, testKey } from './kit.ts';
import {
  ENTRIES,
  PLAINTEXT_SAMPLES,
  localEnv,
  makeDir,
  memoryLogger,
  platformIndex,
  removeDir,
  secretsOf,
  settle,
  settleSync,
  startEntry,
  writeFiles,
  type LocalFiles,
} from './wiring-kit.ts';

// Starting Nest (and loading it the first time) is slow on CI runners: explicit timeout.
const NEST_TIMEOUT_MS = 30_000;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) removeDir(dir);
});

function fresh(label: string): LocalFiles {
  const dir = makeDir(label);
  dirs.push(dir);
  return writeFiles(dir);
}

/** Runs every method of the cipher on every sample; returns what did not work as it should. */
function exercise(fc: FieldCrypto): string[] {
  const problems: string[] = [];
  for (const [label, value] of Object.entries(PLAINTEXT_SAMPLES)) {
    const context = 'payout_accounts.account';
    const own = fc.encrypt(value, context);
    if (fc.decrypt(own, context) !== value) problems.push(`decrypt ${label}`);
    const old = referenceEncrypt(testKey(1), 1, value, context);
    if (!fc.needsReencrypt(old) || fc.keyVersionOf(old) !== 1) problems.push(`version ${label}`);
    if (fc.decrypt(fc.reencrypt(old, context), context) !== value)
      problems.push(`reencrypt ${label}`);
    if (fc.blindIndex(value, context) !== fc.blindIndex(value, context))
      problems.push(`blind ${label}`);
  }
  return problems;
}

it.each(ENTRIES)(
  '[BR-ID-33] %s 入口：经注入的 FIELD_CRYPTO 加密、解密、reencrypt、盲索引手机号、身份证号、收款账号与姓名之后，日志里没有这些明文',
  async (entry) => {
    const token = (await platformIndex())['FIELD_CRYPTO'];
    expect(typeof token).toBe('symbol');
    const files = fresh(`r2-logs-${entry}`);
    const { logger, lines } = memoryLogger(entry, 'test');
    const started = await settle(
      startEntry(entry, { config: loadConfig(localEnv('test', files)), logger }),
    );
    expect('value' in started ? 'started' : String(started.error)).toBe('started');
    if (!('value' in started)) return;
    const injected = settleSync(() => started.value.get(token) as FieldCrypto);
    const problems = 'value' in injected ? exercise(injected.value) : ['not provided'];
    await started.value.close();
    expect(problems).toEqual([]);
    // The logger is the one the entry used: Nest wrote its start-up lines into it.
    expect(lines.length).toBeGreaterThan(0);
    expect([...new Set(lines.flatMap((line) => leaksIn(line, secretsOf(files))))]).toEqual([]);
  },
  NEST_TIMEOUT_MS,
);
