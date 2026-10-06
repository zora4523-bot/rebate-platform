import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, expect, it, vi } from 'vitest';
import { build } from 'vite';
import ts from 'typescript';
import { ROOT, requiredText } from './kit.ts';

afterEach(() => vi.unstubAllEnvs());

type Entry = 'app' | 'landing' | 'conformance';

function entryFiles(entry: Entry) {
  const base = `apps/h5/src/entries/${entry}/`;
  const html = requiredText(`${base}index.html`);
  const main = requiredText(`${base}main.tsx`);
  expect(html).toMatch(/<script\b[^>]*type=["']module["']/);
  expect(html).toMatch(/src=["'](?:\.\/|\/)?main\.tsx["']/);
  expect(html).toMatch(/name=["']viewport["']/);
  expect(html).toContain('viewport-fit=cover');
  if (entry === 'landing') {
    const seen = new Set<string>();
    function checkStaticImports(file: string) {
      if (seen.has(file)) return;
      seen.add(file);
      const source = ts.createSourceFile(
        file,
        requiredText(file),
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      for (const node of source.statements) {
        if (
          !(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ||
          !node.moduleSpecifier ||
          !ts.isStringLiteral(node.moduleSpecifier)
        )
          continue;
        const name = node.moduleSpecifier.text;
        expect(name === 'react-dom' || name.startsWith('react-dom/'), file).toBe(false);
        // Follow local static dependencies, including shared modules and re-exports.
        // Styles/assets and dynamic imports do not add synchronous JS dependencies here.
        if (!name.startsWith('.') || /\.(?:css|json|svg|png|jpe?g|webp)$/.test(name)) continue;
        const resolved = ts.resolveModuleName(
          name,
          file,
          { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true },
          ts.sys,
        ).resolvedModule;
        expect(resolved, `static dependency ${name} from ${file}`).toBeDefined();
        checkStaticImports(resolved!.resolvedFileName);
      }
    }
    checkStaticImports(fileURLToPath(new URL(`${base}main.tsx`, ROOT)));
  } else {
    expect(main).toMatch(/\bcreateRoot\b/);
  }
  return { html, main };
}

async function bundle(entry: Entry) {
  const result = await build({
    configFile: fileURLToPath(new URL('apps/h5/vite.config.ts', ROOT)),
    mode: entry,
    logLevel: 'silent',
    plugins: [
      {
        name: 'h5-entry-contract-assertions',
        configResolved(config) {
          expect(config.root.replace(/\/$/, '')).toBe(
            fileURLToPath(new URL(`apps/h5/src/entries/${entry}`, ROOT)),
          );
          expect(config.build.outDir.replace(/\/$/, '')).toBe(
            fileURLToPath(new URL(`apps/h5/dist/web/${entry}`, ROOT)),
          );
        },
      },
    ],
    build: { write: false },
  });
  expect(Array.isArray(result)).toBe(false);
  expect('output' in result).toBe(true);
  if (!('output' in result)) throw new Error('unreachable after output assertion');
  return result.output;
}

it.each(['app', 'landing', 'conformance'] as const)(
  '[AC-F1-01c-BUILD#1] %s 独立 HTML/React 入口可构建且不混入另外两个入口',
  async (entry) => {
    entryFiles(entry);
    vi.stubEnv('APP_ENV', 'staging');
    const output = await bundle(entry);
    const chunks = output.filter((item) => item.type === 'chunk');
    expect(output.some((item) => item.type === 'asset' && item.fileName === 'index.html')).toBe(
      true,
    );
    const entryChunks = chunks.filter((item) => item.isEntry);
    expect(entryChunks).toHaveLength(1);
    const modules = chunks.flatMap((item) => Object.keys(item.modules));
    expect(modules.some((id) => id.includes(`/entries/${entry}/main.tsx`))).toBe(true);
    for (const other of ['app', 'landing', 'conformance'].filter((name) => name !== entry)) {
      expect(modules.some((id) => id.includes(`/src/entries/${other}/`))).toBe(false);
    }

    function staticClosure(file: string, seen = new Set<string>()): Set<string> {
      if (seen.has(file)) return seen;
      const chunk = chunks.find((item) => item.fileName === file);
      expect(chunk, `local JS chunk ${file}`).toBeDefined();
      seen.add(file);
      for (const imported of chunk!.imports) staticClosure(imported, seen);
      return seen;
    }
    function compressedSize(files: Set<string>) {
      return [...files].reduce((size, file) => {
        const chunk = chunks.find((item) => item.fileName === file)!;
        return size + gzipSync(chunk.code).byteLength;
      }, 0);
    }
    const initial = staticClosure(entryChunks[0]!.fileName);
    if (entry === 'landing') {
      expect(modules.some((id) => /(?:packages\/bridge-sdk|@couli\/bridge-sdk)/.test(id))).toBe(
        false,
      );
      expect(compressedSize(initial), 'landing initial JS gzip <= 60 KiB').toBeLessThanOrEqual(
        60 * 1024,
      );
    }
    if (entry === 'app') {
      const lazy = chunks.filter((item) => item.isDynamicEntry);
      expect(
        lazy.length,
        'real route chunks, not Promise.resolve of an eager component',
      ).toBeGreaterThan(0);
      for (const chunk of lazy) {
        const routeFiles = new Set([...initial, ...staticClosure(chunk.fileName)]);
        expect(
          compressedSize(routeFiles),
          `${chunk.fileName}: initial + route JS gzip <= 150 KiB`,
        ).toBeLessThanOrEqual(150 * 1024);
      }
    }
  },
  60_000,
);

it.each(['prod', '', 'unexpected-env'])(
  '[AC-F1-01c-BUILD#2] conformance 在非许可 APP_ENV=%s 下拒绝构建',
  async (environment) => {
    entryFiles('conformance');
    vi.stubEnv('APP_ENV', environment);
    await expect(
      build({
        configFile: fileURLToPath(new URL('apps/h5/vite.config.ts', ROOT)),
        mode: 'conformance',
        logLevel: 'silent',
        build: { write: false },
      }),
    ).rejects.toThrow(/conformance/i);
  },
  60_000,
);

it('[AC-F1-01c-BUILD#3] 三个入口导入 Tailwind 与令牌样式，扫描根覆盖整个 src，并处理安全区', () => {
  for (const entry of ['app', 'landing', 'conformance'] as const) entryFiles(entry);
  const stylesRoot = new URL('apps/h5/src/shared/styles/', ROOT);
  // Assert before filesystem enumeration so the red phase never fails with ENOENT.
  const appMain = requiredText('apps/h5/src/entries/app/main.tsx');
  expect(appMain).toMatch(/shared\/styles/);
  expect(existsSync(stylesRoot), 'shared styles directory').toBe(true);
  const files = readdirSync(stylesRoot, { recursive: true, encoding: 'utf8' }).filter((name) =>
    name.endsWith('.css'),
  );
  expect(files.length).toBeGreaterThan(0);
  const css = files
    .map((file) => requiredText(`apps/h5/src/shared/styles/${file}`))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  expect(css).toMatch(/@import\s+['"]tailwindcss['"]\s+source\(['"]\.\.\/\.\.\/['"]\)/);
  expect(css).toMatch(/@import\s+['"]@couli\/ui-tokens\/tokens\.css['"]/);
  expect(css).toMatch(/@import\s+['"]@couli\/ui-tokens\/tailwind\.css['"]/);
  expect(css).toMatch(/env\(safe-area-inset-(?:top|bottom)/);
  for (const entry of ['landing', 'conformance']) {
    expect(requiredText(`apps/h5/src/entries/${entry}/main.tsx`)).toMatch(/shared\/styles/);
  }
});

it('[AC-F1-01c-BUILD#4] landing 源码不导入 bridge-sdk，包括 type、转出与动态导入', () => {
  entryFiles('landing');
  const prefix = 'apps/h5/src/entries/landing/';
  const files = readdirSync(new URL(prefix, ROOT), { recursive: true, encoding: 'utf8' }).filter(
    (file) => /\.[cm]?tsx?$/.test(file),
  );
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      requiredText(prefix + file),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const imports: string[] = [];
    function visit(node: ts.Node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imports.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const target = node.arguments[0];
        if (target && ts.isStringLiteral(target)) imports.push(target.text);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(
      imports.filter(
        (name) => name === '@couli/bridge-sdk' || name.startsWith('@couli/bridge-sdk/'),
      ),
      file,
    ).toEqual([]);
  }
});
