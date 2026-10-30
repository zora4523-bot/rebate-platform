// B1-05o public section items use case, GET /v1/pages/{page_key}/sections/{section_id}/items
// (contract listPageSectionItems, CT-07c; BR-TEXT-17 细则「联盟物料频道」): the union_material data
// source of a published section. Rule tests: test/spec/catalog/section-items/**.
// TODO(规划/11 §4.5): 类目黑名单 — blocked on UnionItem 类目字段（CAP-*-03）
import type { components } from '@couli/contracts-ts';
import type { Logger } from 'pino';
import type { MaterialChannelsSpec } from '../platform/index.ts';
import type { CatalogCardEntry } from './application/card-entry.ts';
import type { HotRankUpstream } from './hot-rank.ts';
import type { ViewerContext } from './ports.ts';

export type PageSectionItemsData = components['schemas']['PageSectionItemsData'];

export interface SectionItemsQuery {
  readonly pageKey: string;
  readonly sectionId: string;
  readonly cursor?: string;
}

export interface SectionItemsSection {
  readonly dataSource: unknown;
}

/** 读已发布页面里的一张卡片：版本与 min_app_version 同 getPage，condition 不判定；没有返回 null。 */
export interface SectionItemsPages {
  section(input: {
    readonly appId: string;
    readonly pageKey: string;
    readonly sectionId: string;
    readonly deviceId: string | null;
  }): Promise<SectionItemsSection | null>;
}

export interface SectionItemsOptions {
  readonly viewerContext: ViewerContext;
  readonly cards: CatalogCardEntry;
  /** Read before every fetch (production: platform's getMaterialChannels). */
  readonly channels: () => MaterialChannelsSpec;
  /** Production: cacheHotRankUpstream(createUnionHotRankUpstream(...)), the hot list's fetch. */
  readonly upstream: HotRankUpstream;
  readonly pages: SectionItemsPages;
  readonly logger: Pick<Logger, 'warn'>;
}

export function getSectionItems(
  query: SectionItemsQuery,
  options: SectionItemsOptions,
): Promise<PageSectionItemsData> {
  void query;
  void options;
  throw new Error('NotImplemented: getSectionItems');
}
