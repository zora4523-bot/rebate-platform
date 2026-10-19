import type { Schema } from '@couli/contracts-ts';

export interface ArticleAdminActor {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}
export interface ArticleAdminQuery {
  readonly page?: number;
  readonly page_size?: number;
  readonly category?: Schema<'ArticleCategory'>;
  readonly status?: Schema<'ArticleVersionStatus'>;
}

// F1-02w test 阶段：只有用例签名；控制器、事务和校验由实现阶段接入。
export class ArticleAdmin {
  async list(appId: string, query: ArticleAdminQuery): Promise<Schema<'AdminArticleList'>> {
    void appId;
    void query;
    throw new Error('NotImplemented: ArticleAdmin.list');
  }
  async detail(appId: string, articleId: string): Promise<Schema<'AdminArticle'>> {
    void appId;
    void articleId;
    throw new Error('NotImplemented: ArticleAdmin.detail');
  }
  async create(
    actor: ArticleAdminActor,
    input: Schema<'AdminArticleCreateRequest'>,
  ): Promise<Schema<'AdminArticle'>> {
    void actor;
    void input;
    throw new Error('NotImplemented: ArticleAdmin.create');
  }
  async save(
    actor: ArticleAdminActor,
    articleId: string,
    input: Schema<'AdminArticleDraftRequest'>,
  ): Promise<Schema<'AdminArticle'>> {
    void actor;
    void articleId;
    void input;
    throw new Error('NotImplemented: ArticleAdmin.save');
  }
  async publish(
    actor: ArticleAdminActor,
    articleId: string,
    input: Schema<'AdminArticlePublishRequest'>,
  ): Promise<Schema<'AdminArticle'>> {
    void actor;
    void articleId;
    void input;
    throw new Error('NotImplemented: ArticleAdmin.publish');
  }
  async offline(
    actor: ArticleAdminActor,
    articleId: string,
    input: Schema<'AdminArticleOfflineRequest'>,
  ): Promise<Schema<'AdminArticle'>> {
    void actor;
    void articleId;
    void input;
    throw new Error('NotImplemented: ArticleAdmin.offline');
  }
}
