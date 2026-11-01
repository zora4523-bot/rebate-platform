import type { ReactElement } from 'react';

/** 消息中心（F1-04c，路由 Messages，h5 `/messages`）页面属性：无。 */
export type MessagesPageProps = Record<string, never>;

/**
 * 消息中心：经应用级 API 客户端（桥取 H5 令牌）读 listMessages 游标分页，读 GET /v1/me/deletion
 * 判断注销冷静期；有 route 的行经 nav.open 跳转并标已读，「全部已读」以 {all:true} 标已读。
 */
export function MessagesPage(props: MessagesPageProps): ReactElement {
  void props;
  throw new Error('NotImplemented: MessagesPage');
}

/** Route module shape (React Router `lazy`): the Messages route renders this page. */
export { MessagesPage as Component };
