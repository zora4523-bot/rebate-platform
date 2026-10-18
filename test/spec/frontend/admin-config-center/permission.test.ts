// @vitest-environment jsdom
import { cleanup, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TARGET, createServer, item } from './fixtures.ts';
import { click, editButton, enabled, mount, reveal, row, settled } from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each(['config.general', 'config.risk', 'config.business'] as const)(
  '[AC-F1-06zg-PERMISSION#1] 同一个键由响应 permission=%s 决定编辑权限，不按键名前缀写死',
  async (permission) => {
    const server = createServer([item(TARGET, { permission })]);
    await mount(server, { isSuper: false, permissions: ['config.general'] });
    await reveal(TARGET, server);
    const controls = within(row()).queryAllByRole('button', { name: /编辑/ });
    if (permission === 'config.general') expect(enabled(editButton())).toBe(true);
    else {
      expect(row().textContent).toMatch(/只读|权限|不可.*编辑/);
      expect(controls.every((node) => !enabled(node))).toBe(true);
      for (const control of controls) await click(control);
      await settled(server);
      expect(server.requests('PUT')).toEqual([]);
      expect(server.requests('POST')).toEqual([]);
    }
  },
);

it.each(['config.risk', 'config.business'] as const)(
  '[AC-F1-06zg-PERMISSION#2] 只持 %s 可以读列表并编辑该权限行，无需 general 权限',
  async (permission) => {
    const server = createServer([item(TARGET, { permission })]);
    await mount(server, { isSuper: false, permissions: [permission] });
    await reveal(TARGET, server);
    expect(enabled(editButton())).toBe(true);
    expect(server.requests('POST')).toEqual([]);
  },
);
