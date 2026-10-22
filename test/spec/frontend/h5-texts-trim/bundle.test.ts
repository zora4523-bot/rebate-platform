import { afterEach, expect, it, vi } from 'vitest';
import { assertPruned, bundle, contractDictionary } from './trim-kit.ts';

afterEach(() => vi.unstubAllEnvs());

it('[AC-F1-01t-BUNDLE#1] app 保留字面与登记动态键，删除原生专用键和值', async () => {
  const dictionary = contractDictionary();
  const { code, dictionary: bundled } = await bundle('app');
  for (const key of [
    'h5.load_failed',
    'claim.guide.order_no',
    'ledger_type.REWARD.name_invite',
    'ledger_type.REWARD.hint_invite',
    'ledger_type.BAD_DEBT_WRITEOFF.hint',
    'claim.records.status.approved',
    'claim.records.desc.pending',
    'claim_reject_reason.NO_EVIDENCE.title',
    'claim_reject_reason.NOT_IN_POOL.title',
    'error.30202.FACTOR_MISMATCH',
    'error.30202.CLAIM_EXPIRED',
  ]) {
    expect(dictionary.texts[key], key).toBeTypeOf('string');
    // ledger/find-order local defaults repeat some values: require the key in the plugin's
    // actual replacement dictionary too, so those local strings cannot hide a dropped family.
    expect(bundled.texts[key], key).toBe(dictionary.texts[key]);
    expect(code, key).toContain(dictionary.texts[key]!);
  }
  expect(code).toContain(dictionary.fallbacks['claim.guide.order_no']!);
  assertPruned(code, dictionary);
}, 60_000);

it('[AC-F1-01t-BUNDLE#2] landing 使用全 src 收集字典，保留引用键并删除原生专用键', async () => {
  const { code, dictionary: bundled } = await bundle('landing');
  // landing currently uses only h5.shell.page_pending, whose default is shell-local.
  expect(code).toContain('页面暂未开放');
  assertPruned(code);
  const dictionary = contractDictionary();
  for (const key of [
    'claim.guide.order_no',
    'ledger_type.BAD_DEBT_WRITEOFF.hint',
    'claim_reject_reason.NO_EVIDENCE.title',
    'error.30202.FACTOR_MISMATCH',
  ]) {
    expect(bundled.texts[key], key).toBe(dictionary.texts[key]);
    expect(code, key).toContain(dictionary.texts[key]!);
  }
}, 60_000);

it('[AC-F1-01t-BUNDLE#3] conformance 共用全 src 收集结果，未使用的字典不进入 JS', async () => {
  // bundle() also checks the emitted replacement object against the entire src collection.
  vi.stubEnv('APP_ENV', 'staging');
  const { code } = await bundle('conformance');
  assertPruned(code);
  expect(code).not.toContain(contractDictionary().texts['claim.guide.order_no']!);
}, 60_000);
