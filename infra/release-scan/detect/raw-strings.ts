// 叶子模块：结构化视图（JSON 键值行）的原值视图，encoding.ts（textViews）与 association.ts 共用。

/**
 * 关联视图逐行是 JSON 键值行：取值两端是引号而不是二进制字节，单行 `shared_salt=demo-v1` 这类
 * 字符串资源不会被当作独立配置串；含引号、反斜杠、换行的取值还会被再次转义（{\"shared_salt\":…}）。
 * 这里把视图里解码后的全部字符串（键与取值）按原样取出，以 NUL 分隔另作一个视图检测，
 * 与二进制里的独立串（main 的原始字节扫描）同一口径。
 */
export function rawStrings(text: string): string | undefined {
  const raw = new Set<string>();
  const take = (value: unknown): void => {
    if (typeof value === 'string' && value !== '') raw.add(value);
  };
  for (const line of text.split('\n')) {
    if (line === '') continue;
    let parsed: unknown;
    try {
      // 关联行 `"键":"值"`；孤立行 `"值"` 不是合法对象体，回退按 JSON 串解析。
      parsed = line.startsWith('"') && !line.endsWith('"') ? undefined : JSON.parse(line);
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined) {
      try {
        parsed = JSON.parse(`{${line}}`);
      } catch {
        continue;
      }
    }
    if (typeof parsed === 'string') take(parsed);
    else if (parsed && typeof parsed === 'object') {
      for (const [key, value] of Object.entries(parsed)) {
        take(key);
        take(value);
      }
    }
  }
  return raw.size > 0 ? `\0${[...raw].join('\0')}\0` : undefined;
}
