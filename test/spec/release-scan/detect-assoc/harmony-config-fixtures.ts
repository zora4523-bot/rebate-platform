import { u16, u32 } from './android-fixtures.ts';

export interface HarmonyRecord {
  id: number;
  name: string;
  value: string;
  type: 9 | 14 | 19 | 20;
}

export interface HarmonyConfig {
  params: readonly { type: number; value: number }[];
  records: readonly HarmonyRecord[];
}

/**
 * restool 旧格式：全部 KEYS（含 KeyParam）→ 全部 IDSS → 全部 RecordItem。
 * SaveLimitKeyConfigs / SaveIdSets / SaveRecordItem 逐字段依据：
 * https://raw.githubusercontent.com/openharmony/developtools_global_resource_tool/master/src/resource_table.cpp
 * KeyType LANGUAGE=0 / REGION=1；STRING=9 / COLOR=14 / MEDIA=19 / PROF=20：
 * https://raw.githubusercontent.com/openharmony/developtools_global_resource_tool/master/include/resource_data.h
 * 两字母 locale 以字符顺序压入 uint32（en=0x656e），再按 LE 写入 KeyParam。
 */
export function configuredResourcesIndex(configs: readonly HarmonyConfig[]): Buffer {
  const cstring = (value: string): Buffer => {
    const bytes = Buffer.from(`${value}\0`, 'utf8');
    return Buffer.concat([u16(bytes.length), bytes]);
  };
  const records = configs.map((config) =>
    config.records.map((r) => {
      const body = Buffer.concat([u32(r.type, r.id), cstring(r.value), cstring(r.name)]);
      return Buffer.concat([u32(body.length), body]);
    }),
  );
  let idssAt = 136 + configs.reduce((n, c) => n + 12 + c.params.length * 8, 0);
  let recordAt = idssAt + configs.reduce((n, c) => n + 8 + c.records.length * 8, 0);
  const keys: Buffer[] = [];
  const ids: Buffer[] = [];
  configs.forEach((config, index) => {
    keys.push(
      Buffer.concat([
        Buffer.from('KEYS'),
        u32(idssAt, config.params.length),
        ...config.params.map((param) => u32(param.type, param.value)),
      ]),
    );
    const pairs = config.records.map((record, i) => {
      const pair = u32(record.id, recordAt);
      recordAt += records[index]![i]!.length;
      return pair;
    });
    const idss = Buffer.concat([Buffer.from('IDSS'), u32(config.records.length), ...pairs]);
    ids.push(idss);
    idssAt += idss.length;
  });
  const version = Buffer.alloc(128);
  version.write('Restool 6.1.0.003');
  return Buffer.concat([
    version,
    u32(recordAt, configs.length),
    ...keys,
    ...ids,
    ...records.flat(),
  ]);
}

/** base / en_US / zh_CN，各自独立的 IDSS；同名同 ID 的三种候选值。 */
export function localizedConfigs(values: readonly [string, string, string]): HarmonyConfig[] {
  return [
    [],
    [
      { type: 0, value: 0x656e },
      { type: 1, value: 0x5553 },
    ],
    [
      { type: 0, value: 0x7a68 },
      { type: 1, value: 0x434e },
    ],
  ].map((params, index) => ({
    params,
    records: [
      { id: 0x01000000, type: 9, name: 'build_value', value: values[index]! },
      { id: 0x01000001, type: 14, name: 'accent', value: '#ffffff' },
      { id: 0x01000002, type: 19, name: 'icon', value: 'entry/resources/base/media/icon.svg' },
      {
        id: 0x01000003,
        type: 20,
        name: 'routes',
        value: 'entry/resources/base/profile/routes.json',
      },
    ],
  }));
}
