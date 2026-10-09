import { Layout, Menu, Typography, type MenuProps } from 'antd';
import { Link } from 'react-router';
import type { AdminMenuGroup } from '../resources/index.ts';
import { shellTexts } from '../texts/shell.ts';

export interface SidebarProps {
  readonly groups: readonly AdminMenuGroup[];
  readonly activeId: string | undefined;
}

/** Brand plus the permitted menu groups, in catalogue order (antd Layout.Sider + Menu). */
export function Sidebar({ groups, activeId }: SidebarProps) {
  const items: MenuProps['items'] = groups.map((group) => ({
    type: 'group',
    key: group.key,
    // Group titles stay headings (screen-reader navigation by heading).
    label: <h2 className="admin-nav-heading">{group.label}</h2>,
    children: group.items.map((item) => ({
      key: item.id,
      label: (
        <Link to={`/${item.id}`} aria-current={item.id === activeId ? 'page' : undefined}>
          {item.label}
        </Link>
      ),
    })),
  }));
  return (
    <Layout.Sider theme="light" width={220} className="admin-sider">
      <div className="admin-brand">
        <span className="admin-brand-logo" aria-hidden="true">
          {shellTexts.brandLogo}
        </span>
        <Typography.Text strong>{shellTexts.brand}</Typography.Text>
      </div>
      <nav aria-label={shellTexts.mainNavigation}>
        <Menu
          mode="inline"
          items={items}
          selectedKeys={activeId === undefined ? [] : [activeId]}
          className="admin-nav-menu"
        />
      </nav>
    </Layout.Sider>
  );
}
