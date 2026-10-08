// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import ts from 'typescript';
import { afterEach, expect, it } from 'vitest';
import { PlatformBadge } from '../../../../apps/h5/src/components/platform/index.ts';
import { platforms } from './fixtures.ts';
import { expectBuiltin } from './images.ts';

afterEach(cleanup);

const root = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../apps/h5/src/components/platform/',
);

function visit(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  ts.forEachChild(node, (child) => visit(child, inspect));
}

function sources(): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(
    (path) => /\.(?:tsx?|css)$/.test(path) && !/\.(?:test|d)\.tsx?$/.test(path),
  );
}

it('[AC-F1-01n-SOURCE#1] 中文文案只在 texts，尺寸和颜色使用令牌，不读图片字节或获取配置', () => {
  // Positive behavior first: negative source checks must also be red on the skeleton.
  const view = render(createElement(PlatformBadge, { platform: 'taobao' }));
  expectBuiltin(view.container, 'taobao');
  const violations: string[] = [];
  const colorProbe = document.createElement('span');
  function checkValue(value: string, path: string): void {
    const clean = value.replace(/var\(--[\w-]+\)/g, '').trim();
    if (/^(?:currentcolor|transparent|inherit|initial|unset|none)$/i.test(clean)) return;
    colorProbe.style.color = '';
    colorProbe.style.color = clean;
    if (
      colorProbe.style.color !== '' ||
      /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/i.test(clean) ||
      /\b(?:bg|text|border|fill|stroke)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+)\b/.test(
        clean,
      )
    )
      violations.push(`${path}: literal color ${value}`);
    if (
      /(?:^|\s)(?:h|w|size|px|py|gap|rounded|text|leading)-(?:\d+(?:\.\d+)?(?:\s|$)|\[(?:\d*\.)?\d+(?:px|rem|em|%)?\])/.test(
        clean,
      )
    ) {
      violations.push(`${path}: literal dimension ${value}`);
    }
  }
  const files = sources();
  expect(files).toContain('PlatformBadge.tsx');
  for (const path of files) {
    const source = readFileSync(join(root, path), 'utf8');
    if (path.endsWith('.css')) {
      for (const match of source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .matchAll(/([\w-]+)\s*:\s*([^;{}]+)/g)) {
        checkValue(match[2]!, path);
        if (
          /^(?:height|width|padding(?:-.+)?|border(?:-.+)?|font-size|line-height|gap)$/.test(
            match[1]!,
          )
        ) {
          expect(match[2], `${path}: dimension uses a token`).not.toMatch(/\b\d+(?:px|rem|em)\b/);
        }
      }
      continue;
    }
    const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    visit(tree, (node) => {
      if (
        ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node) ||
        ts.isJsxText(node)
      ) {
        if (
          /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u.test(node.text)
        ) {
          violations.push(`${path}: Chinese literal`);
        }
        if (!ts.isJsxText(node)) checkValue(node.text, path);
      }
      if (ts.isIdentifier(node) && /^(?:fetch|XMLHttpRequest|FileReader|digest)$/.test(node.text)) {
        violations.push(`${path}: image bytes/config must not be read (${node.text})`);
      }
      if (
        ts.isPropertyAssignment(node) &&
        /^(?:height|width|padding.*|border.*|fontSize|lineHeight|gap)$/.test(
          node.name.getText(tree),
        )
      ) {
        if (ts.isNumericLiteral(node.initializer) && node.initializer.text !== '0') {
          violations.push(`${path}: literal dimension ${node.getText(tree)}`);
        }
        if (
          ts.isStringLiteral(node.initializer) &&
          /\b\d+(?:px|rem|em)\b/.test(node.initializer.text)
        ) {
          violations.push(`${path}: literal dimension ${node.getText(tree)}`);
        }
      }
    });
  }
  expect(violations).toEqual([]);
});

it('[AC-F1-01n-ASSETS#1] 八个占位 SVG 作为包内 URL 资源使用，单色中性且不内联 DOM', () => {
  const view = render(createElement(PlatformBadge, { platform: 'taobao' }));
  const implementation = sources()
    .map((path) => readFileSync(join(root, path), 'utf8'))
    .join('\n');
  for (const { key, file } of platforms) {
    view.rerender(createElement(PlatformBadge, { platform: key }));
    expectBuiltin(view.container, file);
    expect(view.container.querySelector('svg')).toBeNull();
    const asset = join(root, 'assets', `${file}.svg`);
    expect(existsSync(asset), `required built-in asset ${file}.svg`).toBe(true);
    const source = readFileSync(asset, 'utf8');
    const svg = new DOMParser().parseFromString(source, 'image/svg+xml');
    expect(svg.querySelector('parsererror')).toBeNull();
    expect(svg.documentElement.localName).toBe('svg');
    expect(svg.documentElement.getAttribute('viewBox')).toBeTruthy();
    expect(svg.querySelector('script, image, foreignObject, a, use, style')).toBeNull();
    expect(svg.querySelector('path, rect, circle, ellipse, polygon, line, text')).not.toBeNull();
    const colors = new Set<string>();
    for (const element of [svg.documentElement, ...svg.querySelectorAll('*')]) {
      for (const attribute of element.attributes) {
        expect(attribute.name).not.toMatch(/^(?:on|href|xlink:href|style)/i);
        if (/^(?:fill|stroke|color)$/.test(attribute.name)) {
          expect(attribute.value).toMatch(/^(?:none|currentColor|var\(--[\w-]+\))$/);
          if (attribute.value !== 'none') colors.add(attribute.value);
        }
      }
    }
    expect(colors.size).toBeLessThanOrEqual(1);
    // Vite 8.3.0 inlines small SVGs even with ?url; ?no-inline preserves asset URLs.
    // Allow URL imports only, excluding ?raw, ?react and ?inline.
    expect(implementation).toMatch(
      new RegExp(
        `(?:from\\s*|import\\s*)['\"]\\./assets/${file}\\.svg(?:\\?url|\\?no-inline)?['\"]`,
      ),
    );
  }
});
