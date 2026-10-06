// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  Dialog,
  EmptyState,
  ErrorState,
  Sheet,
  Skeleton,
  Toast,
} from '../../../../apps/h5/src/components/base/index.ts';

afterEach(cleanup);

it('[AC-F1-01f-TOKENS#1] 六组件可渲染且实现源码不含字面色值或内置调色板', () => {
  // Render first: a NotImplemented skeleton must never pass a source-only negative check.
  render(
    createElement(
      'div',
      null,
      createElement(EmptyState, { title: 'Empty', description: 'Description', icon: null }),
      createElement(ErrorState, { title: 'Error', description: 'Description', icon: null }),
      createElement(Skeleton, { width: 100, height: 20 }),
      createElement(Toast, { message: 'Notice' }),
      createElement(Dialog, { open: true, title: 'Dialog', closeLabel: 'Close', onClose: vi.fn() }),
      createElement(Sheet, { open: false, title: 'Sheet', closeLabel: 'Close', onClose: vi.fn() }),
    ),
  );
  const directory = resolve(import.meta.dirname, '../../../../apps/h5/src/components/base');
  const files = readdirSync(directory, { recursive: true, encoding: 'utf8' }).filter(
    (path) => /\.(?:tsx?|css)$/.test(path) && !/\.test\.tsx?$/.test(path),
  );
  expect(files.length).toBeGreaterThanOrEqual(7);
  const source = files.map((path) => readFileSync(`${directory}/${path}`, 'utf8')).join('\n');
  expect(source).not.toMatch(/#[\da-f]{3,8}\b/i);
  expect(source).not.toMatch(/\b(?:rgba?|hsla?|oklch|oklab|hwb|lab|lch)\s*\(/i);
  expect(source).not.toMatch(
    /\b(?:bg|text|border|ring|outline|fill|stroke|shadow)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+)\b/,
  );
  expect(source).toMatch(/(?:couli-|var\(--)/);
});
