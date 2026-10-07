import type { ArtifactEntry } from './types.ts';

/** 完整制品的字段视图；path 保留引用方的包内路径，text 使用 JSON 键值行。 */
export interface ArtifactTextView {
  path: string;
  text: string;
}

export interface ArtifactTextViews {
  views: ArtifactTextView[];
  /** 损坏的结构、无法解析的签名字段引用记为读取错误；其他条目继续扫描。 */
  errors: string[];
}

/**
 * QA-09d：在同一制品内关联清单与资源表，并恢复可供扫描和 QA-09c 使用的字段视图。
 * 嵌套包分别解析；不跨兄弟包借用资源。scanArtifact 须使用同一关联语义。
 * 不认识的普通条目继续使用既有文本视图，不丢失其他密钥检测。
 */
export function artifactTextViews(entries: readonly ArtifactEntry[]): ArtifactTextViews {
  void entries;
  throw new Error('NotImplemented: artifactTextViews');
}
