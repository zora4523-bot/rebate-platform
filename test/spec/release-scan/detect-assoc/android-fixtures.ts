import { ANDROID_NS } from './fixtures.ts';

// 合成 ResTable / ResXMLTree，独立于被测解析器；只有格式编码，不计算检测期望值。
// 布局依据 AOSP libs/androidfw/include/androidfw/ResourceTypes.h。
export function u32(...values: number[]): Buffer {
  const out = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => out.writeUInt32LE(value >>> 0, i * 4));
  return out;
}

export function u16(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value);
  return out;
}

export function chunk(type: number, header: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([u16(type), u16(header), u32(body.length + 8), body]);
}

export function stringPool(strings: readonly string[]): Buffer {
  const records = strings.map((s) =>
    Buffer.concat([u16(s.length), Buffer.from(s, 'utf16le'), u16(0)]),
  );
  let offset = 0;
  const offsets = records.map((record) => {
    const at = offset;
    offset += record.length;
    return at;
  });
  return chunk(
    1,
    28,
    u32(strings.length, 0, 0, 28 + 4 * strings.length, 0),
    u32(...offsets),
    ...records,
    Buffer.alloc((4 - (offset % 4)) % 4),
  );
}

export type ResValue = string | { ref: number };
export interface Resource {
  name: string;
  value: ResValue;
}

/** 资源 ID = 0x7f010000 + 数组下标；多个配置的键顺序相同。 */
export function arsc(resources: readonly Resource[], alternate?: readonly Resource[]): Buffer {
  const configs = alternate ? [resources, alternate] : [resources];
  const values = configs.flatMap((rs) =>
    rs.flatMap((r) => (typeof r.value === 'string' ? [r.value] : [])),
  );
  const keys = stringPool(resources.map((r) => r.name));
  const types = stringPool(['string']);
  let stringIndex = 0;
  const typeChunks = configs.map((rs, configIndex) => {
    const config = Buffer.alloc(64);
    config.writeUInt32LE(64, 0);
    if (configIndex) config.write('fr', 8, 'ascii');
    const entries = rs.map((r, i) => {
      const type = typeof r.value === 'string' ? 3 : 1;
      const data = typeof r.value === 'string' ? stringIndex++ : r.value.ref;
      return Buffer.concat([u16(8), u16(0), u32(i), u16(8), Buffer.from([0, type]), u32(data)]);
    });
    return chunk(
      0x0201,
      84,
      Buffer.from([1, 0, 0, 0]),
      u32(rs.length, 84 + rs.length * 4),
      config,
      u32(...rs.map((_, i) => i * 16)),
      ...entries,
    );
  });
  const spec = chunk(
    0x0202,
    16,
    Buffer.from([1, 0, 0, 0]),
    u32(resources.length),
    u32(...resources.map(() => (alternate ? 4 : 0))),
  );
  const packageHeader = Buffer.alloc(280);
  packageHeader.writeUInt32LE(0x7f, 0);
  packageHeader.write('com.example.demo', 4, 'utf16le');
  packageHeader.writeUInt32LE(288, 260);
  packageHeader.writeUInt32LE(1, 264);
  packageHeader.writeUInt32LE(288 + types.length, 268);
  packageHeader.writeUInt32LE(resources.length, 272);
  const pkg = chunk(0x0200, 288, packageHeader, types, keys, spec, ...typeChunks);
  return chunk(2, 12, u32(1), stringPool(values), pkg);
}

export interface Metadata {
  name: string;
  attribute: 'value' | 'resource';
  value: ResValue;
  raw?: string;
}

/** 真正的 AXML 属性引用（raw=NONE、TYPE_REFERENCE=1），而不是 XML 文本。 */
export function axml(metadata: readonly Metadata[]): Buffer {
  const none = 0xffffffff;
  const strings = [
    'android',
    ANDROID_NS,
    'manifest',
    'application',
    'meta-data',
    'name',
    'value',
    'resource',
    'package',
    'com.example.demo',
    ...metadata.flatMap((m) => [
      m.name,
      ...(typeof m.value === 'string' ? [m.value] : []),
      ...(m.raw === undefined ? [] : [m.raw]),
    ]),
  ];
  const index = (s: string): number => strings.indexOf(s);
  const attr = (name: string, value: ResValue, ns: number, raw?: string): Buffer => {
    const type = typeof value === 'string' ? 3 : 1;
    const data = typeof value === 'string' ? index(value) : value.ref;
    return Buffer.concat([
      u32(ns, index(name), raw === undefined ? none : index(raw)),
      u16(8),
      Buffer.from([0, type]),
      u32(data),
    ]);
  };
  const start = (name: string, attrs: Buffer[]): Buffer =>
    chunk(
      0x0102,
      16,
      u32(1, none, none, index(name)),
      u16(20),
      u16(20),
      u16(attrs.length),
      u16(0),
      u16(0),
      u16(0),
      ...attrs,
    );
  const end = (name: string): Buffer => chunk(0x0103, 16, u32(1, none, none, index(name)));
  // resource-map 各项按字符串池索引对应 Android 属性的公开资源 ID。
  const attributeIds: Readonly<Record<string, number>> = {
    name: 0x01010003,
    value: 0x01010024,
    resource: 0x01010025,
  };
  const map = strings.map((name) => attributeIds[name] ?? 0);
  return chunk(
    3,
    8,
    stringPool(strings),
    chunk(0x0180, 8, u32(...map)),
    chunk(0x0100, 16, u32(1, none, 0, 1)),
    start('manifest', [attr('package', 'com.example.demo', none)]),
    start('application', []),
    ...metadata.flatMap((m) => [
      start('meta-data', [attr('name', m.name, 1), attr(m.attribute, m.value, 1, m.raw)]),
      end('meta-data'),
    ]),
    end('application'),
    end('manifest'),
    chunk(0x0101, 16, u32(1, none, 0, 1)),
  );
}

// AAB protobuf 字段号依据 AOSP tools/aapt2/Resources.proto：
// https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/master/tools/aapt2/Resources.proto
// 仅编码测试子集，故意不借助生产解析器或第三方 protobuf 库。
export function varint(value: number): Buffer {
  const out: number[] = [];
  do {
    const part = value % 128;
    value = Math.floor(value / 128);
    out.push(part | (value ? 0x80 : 0));
  } while (value);
  return Buffer.from(out);
}

export function pv(field: number, value: number): Buffer {
  return Buffer.concat([varint(field * 8), varint(value)]);
}

export function pb(field: number, value: Buffer | string): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value;
  return Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes]);
}

export type ProtoValue = ResValue | { refName: string } | { bool: boolean };

export function item(value: ProtoValue, stringKind: 2 | 3 | 4 = 2): Buffer {
  if (typeof value === 'string') return pb(stringKind, pb(1, value));
  if ('ref' in value) return pb(1, pv(2, value.ref));
  if ('refName' in value) return pb(1, pb(3, value.refName));
  return pb(7, pv(8, value.bool ? 1 : 0));
}

export interface ProtoResource {
  name: string;
  values: readonly ProtoValue[];
  stringKind?: 2 | 3 | 4;
}

export function resourcesPb(resources: readonly ProtoResource[]): Buffer {
  const entries = resources.map((r, id) =>
    pb(
      3,
      Buffer.concat([
        pb(1, pv(1, id)),
        pb(2, r.name),
        ...r.values.map((v, i) =>
          pb(
            6,
            Buffer.concat([
              // Configuration.locale = 3；用不同配置验证扫描全部候选值。
              pb(1, i === 0 ? Buffer.alloc(0) : pb(3, 'fr')),
              pb(2, pb(4, item(v, r.stringKind))),
            ]),
          ),
        ),
      ]),
    ),
  );
  const type = pb(3, Buffer.concat([pb(1, pv(1, 1)), pb(2, 'string'), ...entries]));
  return pb(2, Buffer.concat([pb(1, pv(1, 0x7f)), pb(2, 'com.example.demo'), type]));
}

export interface ProtoAttribute {
  name: string;
  raw?: string;
  compiled?: ProtoValue;
  ns?: string;
}

export function protoElement(
  name: string,
  attrs: readonly ProtoAttribute[],
  children: readonly Buffer[] = [],
): Buffer {
  return pb(
    1,
    Buffer.concat([
      pb(3, name),
      ...attrs.map((a) =>
        pb(
          4,
          Buffer.concat([
            pb(1, a.ns ?? ANDROID_NS),
            pb(2, a.name),
            ...(a.raw === undefined ? [] : [pb(3, a.raw)]),
            ...(a.compiled === undefined ? [] : [pb(6, item(a.compiled))]),
          ]),
        ),
      ),
      ...children.map((child) => pb(5, child)),
    ]),
  );
}

export function protoManifest(
  metadata: readonly Metadata[],
  attrs: readonly ProtoAttribute[] = [],
): Buffer {
  const children = metadata.map((m) =>
    protoElement('meta-data', [
      { name: 'name', raw: m.name },
      { name: m.attribute, compiled: m.value, ...(m.raw === undefined ? {} : { raw: m.raw }) },
    ]),
  );
  return protoElement(
    'manifest',
    [{ name: 'package', ns: '', raw: 'com.example.demo' }],
    [protoElement('application', attrs, children)],
  );
}
