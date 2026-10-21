// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import { UserRelationsCard } from '../../../../apps/admin/src/pages/users/relations.ts';
import { createAccessControl } from '../../../../apps/admin/src/providers/access-control/index.ts';
import { createDataProvider } from '../../../../apps/admin/src/providers/data/index.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import {
  BASE_URL,
  DETAIL,
  PARENT,
  createRelationsServer,
  detail,
  ok,
} from './relations-fixtures.ts';
import { FLOW_TIMEOUT, button, card, mainElement, show } from './relations-helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it(
  '[AC-F1-07g-VISIBLE#1] 超管三个入口齐全；等级旁调等级，上级卡只显示契约数据',
  async () => {
    await show();
    const relations = card('上级与直推');
    expect(relations.textContent).toContain(PARENT);
    expect(button(relations, '改上级')).toBeDefined();
    expect(button(relations, '查看直推名单')).toBeDefined();
    expect(button(card('基本信息'), '调等级')).toBeDefined();
    for (const text of ['直推数', '直推人数', '绑定来源', '绑定方式', '绑定时间'])
      expect(mainElement().textContent).not.toContain(text);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07g-VISIBLE#2] 只有 user.lookup 可看直推名单，两个写入口隐藏',
  async () => {
    await show(createRelationsServer(), { isSuper: false, permissions: ['user.lookup'] });
    expect(button(card('上级与直推'), '查看直推名单')).toBeDefined();
    expect(within(mainElement()).queryByRole('button', { name: '调等级' })).toBeNull();
    expect(within(mainElement()).queryByRole('button', { name: '改上级' })).toBeNull();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07g-VISIBLE#3] 只有 user.list 可看直推名单，两个写入口隐藏',
  async () => {
    await show(createRelationsServer(), { isSuper: false, permissions: ['user.list'] });
    expect(button(card('上级与直推'), '查看直推名单')).toBeDefined();
    expect(within(mainElement()).queryByRole('button', { name: '调等级' })).toBeNull();
    expect(within(mainElement()).queryByRole('button', { name: '改上级' })).toBeNull();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07g-VISIBLE#4] user.level 不授予 user.inviter',
  async () => {
    await show(createRelationsServer(), {
      isSuper: false,
      permissions: ['user.list', 'user.level'],
    });
    expect(button(card('基本信息'), '调等级')).toBeDefined();
    expect(within(mainElement()).queryByRole('button', { name: '改上级' })).toBeNull();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07g-VISIBLE#5] user.inviter 不授予 user.level',
  async () => {
    await show(createRelationsServer(), {
      isSuper: false,
      permissions: ['user.lookup', 'user.inviter'],
    });
    expect(button(card('上级与直推'), '改上级')).toBeDefined();
    expect(within(mainElement()).queryByRole('button', { name: '调等级' })).toBeNull();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07g-VISIBLE#6] 关系卡无读取权限时不显示直推入口，空上级如实显示',
  async () => {
    installMediaQuery();
    const server = createRelationsServer();
    await act(async () => {
      render(
        createAdminShell({
          router: 'memory',
          initialRoute: { menuId: 'users' },
          permissionsProvider: async () => ({ isSuper: true, permissions: [] }),
          account: { username: 'ops-yi', displayName: '超管' },
          environment: 'test',
          onLogout: vi.fn(),
          dataProvider: createDataProvider({
            baseUrl: BASE_URL,
            fetch: server.fetch,
            getToken: () => 'example-admin-token',
            onError: vi.fn(),
          }),
          renderPage: () =>
            createElement(UserRelationsCard, {
              user: { ...detail(), inviter_user_id: null },
              access: createAccessControl({ isSuper: false, permissions: [] }),
              onOpenUser: vi.fn(),
              onUserChange: vi.fn(),
            }),
        }),
      );
    });
    expect(document.body.textContent).toContain('上级与直推');
    expect(document.body.textContent).toMatch(/—|无上级|暂无上级/);
    expect(document.body.textContent).not.toContain(PARENT);
    expect(screen.queryByRole('button', { name: '查看直推名单' })).toBeNull();
    expect(screen.queryByRole('button', { name: '改上级' })).toBeNull();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07g-VISIBLE#7] adminGetUser 的 null 上级在真实详情卡显示为空',
  async () => {
    const server = createRelationsServer();
    server.once('GET', DETAIL, () => ok({ ...detail(), inviter_user_id: null }));
    await show(server);
    expect(card('上级与直推').textContent).toMatch(/—|无上级|暂无上级/);
    expect(card('上级与直推').textContent).not.toContain(PARENT);
  },
  FLOW_TIMEOUT,
);
