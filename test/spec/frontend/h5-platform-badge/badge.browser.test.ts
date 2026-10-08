/// <reference types="@vitest/browser-playwright" />
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { PlatformBadge } from '../../../../apps/h5/src/components/platform/index.ts';
import '../../../../apps/h5/src/shared/styles/index.css';
import { platforms } from './fixtures.ts';

let root: Root | undefined;
let viewport: { width: number; height: number };

beforeEach(async () => {
  viewport = { width: innerWidth, height: innerHeight };
  await page.viewport(375, 812);
});

afterEach(async () => {
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
  await page.viewport(viewport.width, viewport.height);
});

function computedAppearance(element: HTMLElement): HTMLSpanElement {
  // Vitest's style matcher prefers inline lengths verbatim (e.g. var(--space-5)).
  // Snapshot computed CSS onto a probe so both token classes and inline token styles
  // are checked against the same resolved dimensions, using only expect.element.
  const computed = getComputedStyle(element);
  const probe = document.createElement('span');
  for (const property of computed) {
    probe.style.setProperty(property, computed.getPropertyValue(property));
  }
  document.body.append(probe);
  return probe;
}

it('[AC-F1-01n-VISUAL#1] h5-platform-badge', async () => {
  const container = document.createElement('main');
  container.style.cssText = 'padding:var(--space-4);font-family:var(--font-family-system)';
  document.body.append(container);
  let failure: unknown;
  root = createRoot(container, {
    onUncaughtError: (error) => {
      failure = error;
    },
  });
  flushSync(() =>
    root?.render(
      createElement(
        'section',
        null,
        createElement(
          'article',
          {
            style: {
              padding: 'var(--space-4)',
              borderRadius: 'var(--radius-card)',
              background: 'var(--color-background-surface)',
              marginBottom: 'var(--space-4)',
            },
          },
          createElement(
            'h2',
            { style: { fontSize: 'var(--font-size-body)' } },
            createElement(PlatformBadge, { platform: 'taobao' }),
            ' 日用收纳好物',
          ),
        ),
        // At 375px the eight badges exceed one line: keep the comparison row scrollable.
        createElement(
          'div',
          { style: { overflowX: 'auto' } },
          createElement(
            'div',
            {
              'data-testid': 'platform-row',
              style: { display: 'flex', width: 'max-content', gap: 'var(--space-1)' },
            },
            ...platforms.map(({ key }) => createElement(PlatformBadge, { key, platform: key })),
          ),
        ),
      ),
    ),
  );
  if (failure !== undefined) throw failure;

  await expect.element(page.getByRole('heading', { name: '淘宝 日用收纳好物' })).toBeVisible();
  await expect.element(container.querySelector<HTMLElement>('h2 > span')).toHaveTextContent('淘宝');
  const row = page.getByTestId('platform-row');
  await expect.element(row).toHaveStyle({ display: 'flex', flexWrap: 'nowrap' });
  for (const { name } of platforms) {
    const badge = row.getByText(name, { exact: true });
    await expect.element(badge).toBeVisible();
  }

  // Assert computed appearance on the outer span; label markup may contain a nested span.
  const probe = document.createElement('span');
  probe.style.cssText =
    'color:var(--color-text-secondary);background:var(--color-background-surface);border:var(--component-control-border-width) solid var(--color-border-control)';
  container.append(probe);
  const tokens = getComputedStyle(probe);
  const sourceBorderProbe = document.createElement('span');
  sourceBorderProbe.style.color = 'var(--color-source-border)';
  container.append(sourceBorderProbe);
  const sourceBorder = getComputedStyle(sourceBorderProbe).color;
  for (const badge of container.querySelectorAll<HTMLElement>(
    'h2 > span, [data-testid="platform-row"] > span',
  )) {
    const appearance = computedAppearance(badge);
    await expect.element(appearance).toHaveStyle({
      display: 'inline-flex',
      height: '20px',
      paddingLeft: '8px',
      paddingRight: '8px',
      borderTopWidth: '1px',
      borderRightWidth: '1px',
      borderBottomWidth: '1px',
      borderLeftWidth: '1px',
      borderTopStyle: 'solid',
      // The brief permits control-border-like tokens; the board uses source-border.
      borderTopColor:
        getComputedStyle(badge).borderTopColor === tokens.borderTopColor
          ? tokens.borderTopColor
          : sourceBorder,
      backgroundColor: tokens.backgroundColor,
      color: tokens.color,
      fontSize: '12px',
      lineHeight: '18px',
    });
    const computed = getComputedStyle(badge);
    const { width, height } = badge.getBoundingClientRect();
    const corners = [
      computed.borderTopLeftRadius,
      computed.borderTopRightRadius,
      computed.borderBottomLeftRadius,
      computed.borderBottomRightRadius,
    ];
    // Check the capsule shape, accepting token radii and rounded-full alike.
    appearance.dataset.pillShape = String(
      corners.every((corner) => {
        const [horizontal = '', vertical = horizontal] = corner.split(/\s+/);
        return [horizontal, vertical].every((radius, axis) => {
          const pixels = radius.endsWith('%')
            ? (Number.parseFloat(radius) / 100) * (axis === 0 ? width : height)
            : Number.parseFloat(radius);
          return pixels >= height / 2;
        });
      }),
    );
    await expect.element(appearance).toHaveAttribute('data-pill-shape', 'true');
    appearance.remove();
    const image = badge.querySelector('img');
    await expect.element(image).toBeVisible();
    const imageAppearance = computedAppearance(image!);
    await expect.element(imageAppearance).toHaveStyle({ width: '12px', height: '12px' });
    imageAppearance.remove();
    await expect.element(image).toHaveAttribute('alt', '');
    await expect.element(image).toHaveAttribute('aria-hidden', 'true');
  }
  probe.remove();
  sourceBorderProbe.remove();
  await document.fonts.ready;
  await page.screenshot();
});
