import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { collectH5Texts } from '../../../../apps/h5/build/trim-texts.ts';
import { t } from '../../../../apps/h5/src/shared/texts.ts';
import {
  assertPruned,
  bundle,
  contractDictionary,
  ROOT,
  SOURCE_ROOT,
  UNREFERENCED,
} from './trim-kit.ts';

afterEach(() => vi.unstubAllEnvs());

it('[AC-F1-01t-RUNTIME#1] 实际裁剪构建的 t 保持动态键、fallback、缺变量与壳层兜底语义', async () => {
  const probeId = '\0trim-runtime-probe';
  const textFile = fileURLToPath(new URL('apps/h5/src/shared/texts.ts', ROOT));
  const { chunks, code } = await bundle('app', {
    plugins: [
      {
        name: 'trim-runtime-probe',
        resolveId(id) {
          return id === 'trim-runtime-probe' ? probeId : undefined;
        },
        load(id) {
          if (id !== probeId) return undefined;
          // The production collector scans ALL src, independent of this input's import graph.
          // Do not load or execute any route; ledger/find-order defaults must already be usable.
          // No keys from this test are supplied to the production collector.
          return `export { t } from ${JSON.stringify(textFile)};\n`;
        },
      },
    ],
    build: {
      cssCodeSplit: false,
      rollupOptions: {
        input: 'trim-runtime-probe',
        preserveEntrySignatures: 'strict',
        output: {
          format: 'es',
          entryFileNames: '[name].mjs',
          chunkFileNames: '[name]-[hash].mjs',
        },
      },
    },
  });
  // Runtime assertions only count after pruning; unchanged main must fail this test as well.
  assertPruned(code);
  const entries = chunks.filter((chunk) => chunk.isEntry);
  expect(entries).toHaveLength(1);
  const base = fileURLToPath(new URL('.tmp/h5-texts-trim/', ROOT));
  mkdirSync(base, { recursive: true });
  const workspace = mkdtempSync(join(base, 'trim-runtime-'));
  let built: { t?: (key: string, params?: Record<string, string>) => string };
  try {
    for (const chunk of chunks) {
      const target = join(workspace, chunk.fileName);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, chunk.code);
    }
    // Importing this probe evaluates only t, without running any route or mounting React.
    // All generated code is executed only by the orchestrator's isolated test container.
    const url = pathToFileURL(join(workspace, entries[0]!.fileName)).href;
    built = (await import(/* @vite-ignore */ url)) as typeof built;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
  expect(built.t).toBeTypeOf('function');
  const translate = built.t!;
  const dictionary = contractDictionary();
  for (const key of [
    'h5.load_failed',
    'ledger_type.REWARD.name_invite',
    'ledger_type.REWARD.hint_invite',
    'ledger_type.BAD_DEBT_WRITEOFF.hint',
    'claim.records.status.pending',
    'claim.records.status.approved',
    'claim.records.desc.auto_tracked',
    'claim_reject_reason.NO_EVIDENCE.title',
    'claim_reject_reason.NOT_IN_POOL.title',
    'error.30201',
    'error.30202.FACTOR_MISMATCH',
    'error.30202.CLAIM_EXPIRED',
    'error.30202.ORDER_INVALID',
    'error.30202.ALREADY_YOURS',
    'error.10405',
  ]) {
    expect(dictionary.texts[key], key).toBeTypeOf('string');
    expect(translate(key), key).toBe(dictionary.texts[key]);
  }
  const orderKey = 'claim.guide.order_no';
  expect(translate(orderKey, { platform_name: '平台甲' })).toBe(
    dictionary.texts[orderKey]!.replace('{platform_name}', '平台甲'),
  );
  expect(translate(orderKey)).toBe(dictionary.fallbacks[orderKey]);
  expect(translate(orderKey, { unrelated: '不应替代缺失变量' })).toBe(
    dictionary.fallbacks[orderKey],
  );
  expect(translate(orderKey, { platform_name: '' })).toBe(
    dictionary.texts[orderKey]!.replace('{platform_name}', ''),
  );
  // A referenced key with no fallback retains its unresolved placeholder, as before trimming.
  expect(Object.hasOwn(dictionary.fallbacks, 'claim.guide.window')).toBe(false);
  expect(translate('claim.guide.window')).toBe(dictionary.texts['claim.guide.window']);
  expect(translate('error.50001')).toBe(dictionary.fallbacks['error.50001']);
  expect(translate('error.50001', { trace6: 'abc123' })).toBe(
    dictionary.texts['error.50001']!.replace('{trace6}', 'abc123'),
  );
  expect(translate('h5.shell.page_pending')).toBe('页面暂未开放');
  expect(translate('h5.retry')).toBe('重试');
  expect(translate('trim.unknown.key')).toBe('');
  expect(translate('error.999999999')).toBe('');
  expect(translate('toString')).toBe('');
  expect(translate('__proto__')).toBe('');
  for (const key of UNREFERENCED) expect(translate(key), key).toBe('');
}, 60_000);

it('[AC-F1-01t-RUNTIME#2] 不经 H5 构建插件时仍加载完整契约默认字典', () => {
  const dictionary = contractDictionary();
  const selected = collectH5Texts({ sourceRoot: SOURCE_ROOT, dictionary });
  for (const key of UNREFERENCED) {
    // Positive/negative pairing: build selection prunes these, ordinary Vitest imports do not.
    expect(Object.hasOwn(selected.texts, key), key).toBe(false);
    expect(t(key), key).toBe(dictionary.fallbacks[key] ?? dictionary.texts[key]);
  }
});
