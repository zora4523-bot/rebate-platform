import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { collectH5Texts, type TrimTextDictionary } from '../../../../apps/h5/build/trim-texts.ts';
import { contractDictionary, ROOT, SOURCE_ROOT } from './trim-kit.ts';

function compressedDictionary(dictionary: TrimTextDictionary): number {
  // Unit-level build payload: canonical ordering excludes incidental traversal order.
  const sorted = (record: Record<string, string>) =>
    Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
  return gzipSync(
    JSON.stringify({ texts: sorted(dictionary.texts), fallbacks: sorted(dictionary.fallbacks) }),
  ).byteLength;
}

function withSourceCopy(run: (sourceRoot: string) => void): void {
  const base = fileURLToPath(new URL('.tmp/h5-texts-trim/', ROOT));
  mkdirSync(base, { recursive: true });
  const workspace = mkdtempSync(join(base, 'trim-'));
  try {
    const sourceRoot = join(workspace, 'src');
    cpSync(SOURCE_ROOT, sourceRoot, { recursive: true });
    run(sourceRoot);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

it('[AC-F1-01t-GROWTH#1] 三入口共用的全 src 裁剪载荷不随 4000 个未引用 texts 与 fallbacks 增长', () => {
  const original = contractDictionary();
  const snapshot = structuredClone(original);
  const grown = structuredClone(original);
  for (let index = 0; index < 4000; index += 1) {
    const digest = createHash('sha256').update(`trim-growth-${index}`).digest('hex');
    grown.texts[`native_only.trim_growth.${digest}`] = `未引用正文-${digest}`;
    grown.fallbacks[`native_only.trim_growth.${digest}`] = `未引用兜底-${digest}`;
    // Include fallback-only keys, so a collector cannot forget to filter the fallback map.
    grown.fallbacks[`native_only.trim_fallback.${digest}`] = `仅兜底-${digest}`;
  }
  const grownSnapshot = structuredClone(grown);
  const before = collectH5Texts({ sourceRoot: SOURCE_ROOT, dictionary: original });
  const after = collectH5Texts({ sourceRoot: SOURCE_ROOT, dictionary: grown });
  expect(after).toEqual(before);
  // Chosen unit-level build seam, with zero-byte tolerance and no chunk-hash noise.
  // BUNDLE connects this collector to each entry's emitted replacement dictionary.
  expect(compressedDictionary(after)).toBe(compressedDictionary(before));
  expect(before.texts['claim.guide.order_no']).toBe(original.texts['claim.guide.order_no']);
  expect(before.texts['error.30201']).toBe(original.texts['error.30201']);
  expect(before.fallbacks['claim.guide.order_no']).toBe(original.fallbacks['claim.guide.order_no']);
  expect(original).toEqual(snapshot);
  expect(grown).toEqual(grownSnapshot);

  // Positive control: the supplied dictionary really is the input, rather than a hard-coded
  // snapshot or a second read of contracts/texts.default.json. Referenced additions must flow.
  grown.texts['claim.guide.order_no'] = 'trim-positive-literal';
  grown.texts['error.30201'] = 'trim-positive-dynamic';
  grown.fallbacks['claim.guide.order_no'] = 'trim-positive-fallback';
  const changed = collectH5Texts({
    sourceRoot: SOURCE_ROOT,
    dictionary: grown,
  });
  expect(changed.texts['claim.guide.order_no']).toBe('trim-positive-literal');
  expect(changed.texts['error.30201']).toBe('trim-positive-dynamic');
  expect(changed.fallbacks['claim.guide.order_no']).toBe('trim-positive-fallback');
});

it('[AC-F1-01t-GUARD#1] 保留合法动态调用并拒绝新模块中未登记的模板键', () => {
  withSourceCopy((sourceRoot) => {
    const options = {
      sourceRoot,
      dictionary: contractDictionary(),
    };
    // A reject-everything guard (including NotImplemented) must not pass the negative test.
    const valid = collectH5Texts(options);
    expect(valid.texts['error.30202.CLAIM_EXPIRED']).toBe(
      options.dictionary.texts['error.30202.CLAIM_EXPIRED'],
    );
    writeFileSync(
      join(sourceRoot, 'entries/app/trim-unregistered.ts'),
      "import { t } from '../../shared/texts.ts';\n" +
        'export function uncovered(y: string) { return t(`x.${y}`); }\n',
    );
    // No entry import: the guard must scan all src, not just the current dependency graph.
    expect(() => collectH5Texts(options)).toThrow(
      /(?:unregistered|uncovered|未登记|未注册|未覆盖)/i,
    );
  });
});

it('[AC-F1-01t-GUARD#2] 包装函数的拼接键也不能绕过动态登记', () => {
  withSourceCopy((sourceRoot) => {
    const options = {
      sourceRoot,
      dictionary: contractDictionary(),
    };
    const valid = collectH5Texts(options);
    expect(valid.texts['claim_reject_reason.NO_EVIDENCE.title']).toBe(
      options.dictionary.texts['claim_reject_reason.NO_EVIDENCE.title'],
    );
    writeFileSync(
      join(sourceRoot, 'entries/app/trim-unregistered.ts'),
      "import { findOrderText as translate } from '../../texts/find-order.ts';\n" +
        // Looks similar to a registered prefix, but is NOT claim_reject_reason.<CODE>.title.
        "export function uncovered(y: string) { return translate('claim_reject_reason_extra.' + y); }\n",
    );
    expect(() => collectH5Texts(options)).toThrow(
      /(?:unregistered|uncovered|未登记|未注册|未覆盖)/i,
    );
  });
});

it('[AC-F1-01t-GUARD#3] 全 src 新增字面引用与其 fallback 自动进入集合，未引用邻键不进入', () => {
  withSourceCopy((sourceRoot) => {
    const dictionary = contractDictionary();
    dictionary.texts['trim.literal.used'] = 'trim-literal-text-{value}';
    dictionary.fallbacks['trim.literal.used'] = 'trim-literal-fallback';
    dictionary.texts['trim.literal.unused'] = 'trim-unused-neighbour';
    dictionary.fallbacks['trim.literal.unused'] = 'trim-unused-neighbour-fallback';
    dictionary.fallbacks['trim.literal.fallback_only'] = 'trim-fallback-only';
    writeFileSync(
      join(sourceRoot, 'entries/landing/trim-literal.ts'),
      '\nimport { t as trimTranslate } from "../../shared/texts.ts";\n' +
        'export function literalProbe() { return trimTranslate("trim.literal.used") + trimTranslate("trim.literal.fallback_only"); }\n',
    );
    const selected = collectH5Texts({ sourceRoot, dictionary });
    expect(selected.texts['trim.literal.used']).toBe(dictionary.texts['trim.literal.used']);
    expect(selected.fallbacks['trim.literal.used']).toBe(dictionary.fallbacks['trim.literal.used']);
    expect(selected.fallbacks['trim.literal.fallback_only']).toBe('trim-fallback-only');
    expect(Object.hasOwn(selected.texts, 'trim.literal.unused')).toBe(false);
    expect(Object.hasOwn(selected.fallbacks, 'trim.literal.unused')).toBe(false);
  });
});

it('[AC-F1-01t-GUARD#4] 模板键先存入变量再传给 t 也必须有登记覆盖', () => {
  withSourceCopy((sourceRoot) => {
    const options = { sourceRoot, dictionary: contractDictionary() };
    const valid = collectH5Texts(options);
    expect(valid.texts['error.30202.CLAIM_EXPIRED']).toBe(
      options.dictionary.texts['error.30202.CLAIM_EXPIRED'],
    );
    writeFileSync(
      join(sourceRoot, 'entries/app/trim-unregistered-variable.ts'),
      "import { t } from '../../shared/texts.ts';\n" +
        'export function uncovered(y: string) { const key = `x.${y}`; return t(key); }\n',
    );
    expect(() => collectH5Texts(options)).toThrow(
      /(?:unregistered|uncovered|未登记|未注册|未覆盖)/i,
    );
  });
});

it('[AC-F1-01t-GUARD#5] 拼接键先存入变量再传给包装函数也必须有登记覆盖', () => {
  withSourceCopy((sourceRoot) => {
    const options = { sourceRoot, dictionary: contractDictionary() };
    // Existing ledgerText(key) uses in ledger/format.ts must remain accepted.
    const valid = collectH5Texts(options);
    expect(valid.texts['ledger_type.REWARD.hint_invite']).toBe(
      options.dictionary.texts['ledger_type.REWARD.hint_invite'],
    );
    writeFileSync(
      join(sourceRoot, 'entries/app/trim-unregistered-variable.ts'),
      "import { ledgerText as translate } from '../../texts/ledger.ts';\n" +
        "export function uncovered(y: string) { const key = 'ledger_type_extra.' + y; return translate(key); }\n",
    );
    expect(() => collectH5Texts(options)).toThrow(
      /(?:unregistered|uncovered|未登记|未注册|未覆盖)/i,
    );
  });
});
