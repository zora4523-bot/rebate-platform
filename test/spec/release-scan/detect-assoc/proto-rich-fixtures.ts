import { item, pb, pv, varint } from './android-fixtures.ts';
import { ANDROID_NS } from './fixtures.ts';

// aapt2 Resources.proto：Primitive.float_value=3 (wire 5)，Item.prim=7，
// Value.compound_value=5 → CompoundValue.array=4 → Array.element=1 → Element.item=3；
// Item.file=5 → FileReference.path=1/type=2(PROTO_XML=3)。
// https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/master/tools/aapt2/Resources.proto
export function fixed(field: number, wire: 1 | 5): Buffer {
  const data = Buffer.alloc(wire === 1 ? 8 : 4);
  if (wire === 5) data.writeFloatLE(0.5);
  else data.writeBigUInt64LE(7n);
  return Buffer.concat([varint(field * 8 + wire), data]);
}

export function richResourcesPb(secret = '', brokenFixed?: 1 | 5): Buffer {
  // 未知 fixed64 放在已知消息内部，不能仅在 ResourceTable 顶层跳过未知字段。
  const unknown = fixed(101, 1);
  const wrap = (field: number, bytes: Buffer): Buffer => pb(field, Buffer.concat([bytes, unknown]));
  const entry = (id: number, name: string, value: Buffer): Buffer =>
    wrap(
      3,
      Buffer.concat([
        pb(1, pv(1, id)),
        pb(2, name),
        wrap(6, Buffer.concat([pb(1, Buffer.alloc(0)), wrap(2, value)])),
      ]),
    );
  const type = (id: number, name: string, entries: readonly Buffer[]): Buffer =>
    wrap(3, Buffer.concat([pb(1, pv(1, id)), pb(2, name), ...entries]));
  const primitive =
    brokenFixed === undefined
      ? Buffer.concat([fixed(3, 5), unknown])
      : fixed(brokenFixed === 5 ? 3 : 101, brokenFixed).subarray(0, -1);
  const float = pb(4, pb(7, primitive));
  const array = pb(
    5,
    wrap(4, Buffer.concat([wrap(1, pb(3, item('First'))), wrap(1, pb(3, item('Second')))])),
  );
  const file = pb(4, wrap(5, Buffer.concat([pb(1, 'res/xml/provider_paths.xml'), pv(2, 3)])));
  // 字符串类型故意排在复合资源之后，避免跳过一项时丢失余下条目。
  return wrap(
    2,
    Buffer.concat([
      pb(1, pv(1, 0x7f)),
      pb(2, 'com.example.demo'),
      type(2, 'dimen', [entry(0, 'disabled_alpha', float)]),
      type(3, 'array', [entry(0, 'labels', array)]),
      type(4, 'xml', [entry(0, 'provider_paths', file)]),
      type(1, 'string', [
        entry(0, 'label', pb(4, item('Demo'))),
        entry(1, 'shared_salt', pb(4, item(secret))),
      ]),
    ]),
  );
}

/** 同时在 XmlNode / XmlElement / XmlAttribute / Item / Reference 内放未知字段。 */
export function richProtoManifest(): Buffer {
  const unknown = fixed(101, 1);
  const attr = (name: string, compiled: Buffer): Buffer =>
    pb(
      4,
      Buffer.concat([
        pb(1, ANDROID_NS),
        pb(2, name),
        pb(6, Buffer.concat([compiled, unknown])),
        unknown,
      ]),
    );
  const node = (name: string, attrs: Buffer[], children: Buffer[]): Buffer =>
    Buffer.concat([
      pb(
        1,
        Buffer.concat([pb(3, name), ...attrs, ...children.map((child) => pb(5, child)), unknown]),
      ),
      fixed(102, 5),
    ]);
  const metadata = (name: string, field: string, id: number): Buffer =>
    node(
      'meta-data',
      [attr('name', item(name)), attr(field, pb(1, Buffer.concat([pv(2, id), unknown])))],
      [],
    );
  const provider = node(
    'provider',
    [attr('name', item('androidx.core.content.FileProvider'))],
    [metadata('android.support.FILE_PROVIDER_PATHS', 'resource', 0x7f040000)],
  );
  return node(
    'manifest',
    [],
    [node('application', [], [metadata('title', 'value', 0x7f010000), provider])],
  );
}
