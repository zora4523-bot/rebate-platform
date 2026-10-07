import { u16, u32 } from './android-fixtures.ts';

export interface HarmonyString {
  id: number;
  name: string;
  value: string;
}

/**
 * OpenHarmony 旧版 resources.index：128 字节版本、总长、配置数，KEYS → IDSS → IdItem。
 * STRING 的类型号为 9；字符串使用 uint16 字节长度（含末尾 NUL）。
 * 手工合成格式子集，不复制真实制品；偏移均为文件绝对偏移。
 * 字节布局按 OpenHarmony restool 的 SaveRecordItem / SaveHeader / SaveIdSets：
 * https://raw.githubusercontent.com/openharmony/developtools_global_resource_tool/master/src/resource_table.cpp
 */
export function resourcesIndex(strings: readonly HarmonyString[]): Buffer {
  const cstring = (s: string): Buffer => {
    const bytes = Buffer.from(`${s}\0`, 'utf8');
    return Buffer.concat([u16(bytes.length), bytes]);
  };
  const records = strings.map((s) => {
    const body = Buffer.concat([u32(9, s.id), cstring(s.value), cstring(s.name)]);
    // RecordItem.size 不含 size 字段自己的 4 字节。
    return Buffer.concat([u32(body.length), body]);
  });
  const idssAt = 148;
  let offset = idssAt + 8 + strings.length * 8;
  const pairs = records.map((record, i) => {
    const pair = u32(strings[i]!.id, offset);
    offset += record.length;
    return pair;
  });
  const version = Buffer.alloc(128);
  version.write('Restool 6.1.0.003');
  return Buffer.concat([
    version,
    u32(offset, 1),
    Buffer.from('KEYS'),
    u32(idssAt, 0),
    Buffer.from('IDSS'),
    u32(strings.length),
    ...pairs,
    ...records,
  ]);
}

export interface HarmonyMetadata {
  name: string;
  value?: string;
  resource?: string;
}

export function moduleJson(
  metadata: readonly HarmonyMetadata[],
  scope: 'module' | 'ability' | 'extension' = 'module',
): string {
  const module = {
    name: 'entry',
    type: 'entry',
    deviceTypes: ['phone'],
    ...(scope === 'module' ? { metadata } : {}),
    abilities: [
      {
        name: 'EntryAbility',
        srcEntry: './ets/entryability/EntryAbility.ets',
        ...(scope === 'ability' ? { metadata } : {}),
      },
    ],
    ...(scope === 'extension'
      ? { extensionAbilities: [{ name: 'DemoExtension', type: 'service', metadata }] }
      : {}),
  };
  return JSON.stringify({
    app: { bundleName: 'com.example.demo', versionCode: 1, versionName: '1.0' },
    module,
  });
}
