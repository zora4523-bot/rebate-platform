// B1-08h（D10-35 第 7 条）：订单 content_hash = sha256 hex，对 UnionOrder 去掉 raw_payload_id 后的
// 规范 JSON：对象键按码元排序（嵌套同样）、数组保序、bigint → 十进制字符串、Date → ISO、
// undefined 的键省略。同内容不同页（只有 raw_payload_id 不同）得到同一个 hash。
import { createHash } from 'node:crypto';
import type { UnionOrder } from '../../union/index.ts';

function canonical(value: unknown): string | undefined {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return JSON.stringify(value);
    case 'bigint':
      return JSON.stringify(value.toString(10));
    case 'object':
      break;
    default:
      return undefined;
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item) ?? 'null').join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const text = canonical(obj[key]);
    if (text !== undefined) parts.push(`${JSON.stringify(key)}:${text}`);
  }
  return `{${parts.join(',')}}`;
}

/** Canonical JSON text hashed by orderContentHash (exported for unit tests and diagnostics). */
export function orderCanonicalJson(order: UnionOrder): string {
  const { raw_payload_id: _ignored, ...rest } = order;
  void _ignored;
  return canonical(rest) ?? '{}';
}

export function orderContentHash(order: UnionOrder): string {
  return createHash('sha256').update(orderCanonicalJson(order)).digest('hex');
}
