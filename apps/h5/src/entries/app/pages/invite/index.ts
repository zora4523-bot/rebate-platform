import type { ReactElement } from 'react';

export type InvitePageProps = Record<string, never>;

/**
 * 邀请好友（F1-05a，路由 InviteShare，h5 `/invite`）。测试阶段骨架：实现阶段按
 * test/spec/frontend/h5-invite/** 补齐。
 */
export function InvitePage(props: InvitePageProps): ReactElement {
  void props;
  throw new Error('NotImplemented: InvitePage');
}

/** Route module shape (React Router `lazy`): the InviteShare route renders this page. */
export { InvitePage as Component };
