import { parseYamlLite, YamlLiteError } from '../../../tools/lib/yaml-lite.ts';
import type { ClientPlatform, PublicIdCategory } from './types.ts';

export interface PublicItem {
  id: string;
  category: PublicIdCategory;
  platforms: ClientPlatform[];
}

interface MatchEntry {
  rule: string;
  file: string;
}

interface ExceptionEntry extends MatchEntry {
  approval: number;
}

interface Manifest {
  items: PublicItem[];
  false_positives: MatchEntry[];
  exceptions: ExceptionEntry[];
}

const CATEGORIES: readonly string[] = [
  'request_routing',
  'wechat',
  'system_capability',
  'huawei',
  'push_client',
  'union_sdk',
  'crash_report',
  'config_verification',
];
const PLATFORMS: readonly string[] = ['ios', 'android', 'harmony', 'h5', 'admin'];

function object(value: unknown, path: string, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path}: 必须是映射`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !fields.includes(key))) {
    throw new Error(`${path}: 包含未知字段`);
  }
  return record;
}

function text(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${path}.${key}: 必须是非空字符串`);
  }
  return value;
}

function list(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new Error(`${key}: 必须是列表`);
  return value as unknown[];
}

function parseManifest(yaml: string): Manifest {
  let parsed: unknown;
  try {
    parsed = parseYamlLite(yaml);
  } catch (error) {
    // 解析器原始错误可能含清单里的敏感值；报告只给出位置。
    throw new Error(
      error instanceof YamlLiteError ? `YAML 第 ${error.line} 行语法无效` : 'YAML 无效',
    );
  }
  const root = object(parsed, 'manifest', [
    'version',
    'items',
    'false_positives',
    'exceptions',
    'never_accepted',
  ]);
  if (!/^[1-9][0-9]*$/.test(text(root, 'version', 'manifest'))) {
    throw new Error('version: 必须是正整数形式的版本字符串');
  }
  const ids = new Set<string>();
  const items = list(root, 'items').map((value, index): PublicItem => {
    const path = `items[${index}]`;
    const entry = object(value, path, [
      'id',
      'category',
      'name',
      'purpose',
      'platforms',
      'why_public',
    ]);
    const id = text(entry, 'id', path);
    if (ids.has(id)) throw new Error(`${path}.id: 重复标识`);
    ids.add(id);
    const category = text(entry, 'category', path);
    if (!CATEGORIES.includes(category)) throw new Error(`${path}.category: 未知类别`);
    for (const key of ['name', 'purpose', 'why_public']) text(entry, key, path);
    const platforms = list(entry, 'platforms');
    if (
      platforms.length === 0 ||
      platforms.some((p) => typeof p !== 'string' || !PLATFORMS.includes(p))
    ) {
      throw new Error(`${path}.platforms: 必须列出有效客户端`);
    }
    return { id, category: category as PublicIdCategory, platforms: platforms as ClientPlatform[] };
  });
  const false_positives = list(root, 'false_positives').map((value, index): MatchEntry => {
    const path = `false_positives[${index}]`;
    const entry = object(value, path, ['rule', 'file', 'reason']);
    text(entry, 'reason', path);
    return { rule: text(entry, 'rule', path), file: text(entry, 'file', path) };
  });
  const exceptions = list(root, 'exceptions').map((value, index): ExceptionEntry => {
    const path = `exceptions[${index}]`;
    const entry = object(value, path, [
      'sdk',
      'item',
      'rule',
      'file',
      'scope_if_leaked',
      'server_side_limit',
      'approval',
    ]);
    for (const key of ['sdk', 'item', 'scope_if_leaked', 'server_side_limit'])
      text(entry, key, path);
    const approval = entry.approval;
    if (typeof approval !== 'number' || !Number.isSafeInteger(approval) || approval <= 0) {
      throw new Error(`${path}.approval: 必须是批准记录的正整数 id`);
    }
    return { rule: text(entry, 'rule', path), file: text(entry, 'file', path), approval };
  });
  // 这里只验证说明字段；不可豁免判定不由这份可编辑说明开启或关闭。
  if (list(root, 'never_accepted').some((v) => typeof v !== 'string' || !v.trim())) {
    throw new Error('never_accepted: 必须是非空说明字符串列表');
  }
  return { items, false_positives, exceptions };
}

export function readManifest(yaml: string): { manifest: Manifest | null; errors: string[] } {
  try {
    return { manifest: parseManifest(yaml), errors: [] };
  } catch (error) {
    return { manifest: null, errors: [error instanceof Error ? error.message : '清单无效'] };
  }
}
