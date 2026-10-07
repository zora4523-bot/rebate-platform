import { expect, it } from 'vitest';
import { buildZip } from '../detect/fixtures.ts';
import {
  expectClean,
  expectPair,
  expectSecret,
  expectUnreadable,
  inspect,
  SHORT,
} from './fixtures.ts';
import { moduleJson, resourcesIndex } from './harmony-fixtures.ts';

// BR-ID-09：内置签名材料无论长短都阻断；QA-09d §9：合法制品放行，坏结构 fail-closed。
it.each(['module', 'ability', 'extension'] as const)(
  '[AC-QA-09d-HAP#1] %s metadata 的 name/value 关联，而非把两个属性各自扫描',
  async (scope) => {
    const result = await inspect('hap', [
      {
        name: 'module.json',
        data: moduleJson(
          [
            { name: 'shared_salt', value: SHORT },
            { name: 'title', value: 'Demo' },
          ],
          scope,
        ),
      },
    ]);
    expectPair(result, 'module.json', 'shared_salt', SHORT);
    expectSecret(result, 'module.json', SHORT);
  },
  30_000,
);

it.each(['shared_salt', 'install_secret', 'signKey', 'hmac_secret'])(
  '[AC-QA-09d-HAP#2] resources.index 字符串资源 %s 恢复名字和值',
  async (name) => {
    const result = await inspect('hap', [
      { name: 'module.json', data: moduleJson([]) },
      {
        name: 'resources.index',
        data: resourcesIndex([
          { id: 0x01000000, name: 'label', value: 'Demo' },
          { id: 0x01000001, name, value: SHORT },
        ]),
      },
    ]);
    expectPair(result, 'resources.index', name, SHORT);
    expectSecret(result, 'resources.index', SHORT);
  },
  30_000,
);

it('[AC-QA-09d-HAP#3] metadata.resource 引用普通名字的字符串，按引用方的签名字段检测', async () => {
  const result = await inspect('hap', [
    {
      name: 'module.json',
      data: moduleJson([{ name: 'install_secret', resource: '$string:build_value' }]),
    },
    {
      name: 'resources.index',
      data: resourcesIndex([{ id: 0x01000000, name: 'build_value', value: SHORT }]),
    },
  ]);
  expectPair(result, 'module.json', 'install_secret', SHORT);
  expectSecret(result, 'module.json', SHORT);
  expect(result.scan.hits.some((h) => h.match === '$string:build_value')).toBe(false);
}, 30_000);

it('[AC-QA-09d-HAP#4] 嵌套 HAP 解析关联且命中路径保留包名', async () => {
  const result = await inspect('app', [
    {
      name: 'entry.hap',
      data: buildZip([
        {
          name: 'module.json',
          data: moduleJson([{ name: 'shared_salt', resource: '$string:build_value' }]),
        },
        {
          name: 'resources.index',
          data: resourcesIndex([{ id: 0x01000000, name: 'build_value', value: SHORT }]),
        },
      ]),
    },
  ]);
  expectPair(result, 'entry.hap/module.json', 'shared_salt', SHORT);
  expectSecret(result, 'entry.hap/module.json', SHORT);
}, 30_000);

it.each(['absent-table', 'absent-name', 'sibling-package'] as const)(
  '[AC-QA-09d-HAP#5] 签名字段引用解析不了：%s，不能当空值或借兄弟包放行',
  async (kind) => {
    const module = {
      name: 'module.json',
      data: moduleJson([{ name: 'shared_salt', resource: '$string:build_value' }]),
    };
    const table = {
      name: 'resources.index',
      data: resourcesIndex([{ id: 0x01000000, name: 'other', value: 'Demo' }]),
    };
    const result =
      kind === 'sibling-package'
        ? await inspect('app', [
            { name: 'entry.hap', data: buildZip([module]) },
            {
              name: 'other.hap',
              data: buildZip([
                { name: 'module.json', data: moduleJson([]) },
                {
                  name: 'resources.index',
                  data: resourcesIndex([{ id: 0x01000000, name: 'build_value', value: '' }]),
                },
              ]),
            },
          ])
        : await inspect('hap', kind === 'absent-table' ? [module] : [module, table]);
    expectUnreadable(result, kind === 'sibling-package' ? 'entry.hap/module.json' : 'module.json');
  },
  30_000,
);

it.each([
  'truncated-header',
  'bad-version',
  'file-size',
  'key-offset',
  'item-offset',
  'value-length',
  'record-size',
  'bad-json',
] as const)(
  '[AC-QA-09d-HAP#6] 损坏 / 越界 %s 必须退出码 2',
  async (kind) => {
    let bytes = resourcesIndex([{ id: 0x01000000, name: 'title', value: 'Demo' }]);
    if (kind === 'truncated-header') bytes = bytes.subarray(0, 132);
    if (kind === 'bad-version') bytes.fill(0, 0, 128);
    if (kind === 'file-size') bytes.writeUInt32LE(bytes.length + 1, 128);
    if (kind === 'key-offset') bytes.writeUInt32LE(0xfffffff0, 140);
    if (kind === 'item-offset') bytes.writeUInt32LE(bytes.length + 8, 160);
    if (kind === 'value-length') bytes.writeUInt16LE(0xffff, 176);
    if (kind === 'record-size') bytes.writeUInt32LE(0xfffffff0, 164);
    const result = await inspect('hap', [
      { name: 'module.json', data: kind === 'bad-json' ? '{"module":' : moduleJson([]) },
      { name: 'resources.index', data: bytes },
    ]);
    expectUnreadable(result, kind === 'bad-json' ? 'module.json' : 'resources.index');
  },
  30_000,
);

it('[AC-QA-09d-HAP#7] 合法 HAP：普通 metadata / 字符串引用、空签名值和算法参数必须放行', async () => {
  const result = await inspect('hap', [
    {
      name: 'module.json',
      data: moduleJson([
        { name: 'title', resource: '$string:label' },
        { name: 'shared_salt', value: '' },
        { name: 'saltRounds', value: '10' },
      ]),
    },
    {
      name: 'resources.index',
      data: resourcesIndex([
        { id: 0x01000000, name: 'label', value: 'Demo' },
        { id: 0x01000001, name: 'salt_length', value: '16' },
      ]),
    },
  ]);
  expectPair(result, 'module.json', 'title', 'Demo');
  expectClean(result);
}, 30_000);

it.each(['x', ['demo', 'salt'].join('-'), ['demo', '!#', 'value'].join('')])(
  '[AC-QA-09d-HAP#8] metadata 属性顺序改变也检出非空短值 %s，不依赖高熵过滤',
  async (value) => {
    const result = await inspect('hap', [
      { name: 'module.json', data: moduleJson([{ value, name: 'shared_salt' }]) },
    ]);
    expectPair(result, 'module.json', 'shared_salt', value);
    expectSecret(result, 'module.json', value);
  },
  30_000,
);

it('[AC-QA-09d-HAP#9] resources.index 内部数字 ID 引用链保留签名资源名', async () => {
  const result = await inspect('hap', [
    { name: 'module.json', data: moduleJson([]) },
    {
      name: 'resources.index',
      data: resourcesIndex([
        { id: 0x01000000, name: 'shared_salt', value: '$string:16777217' },
        { id: 0x01000001, name: 'build_value', value: SHORT },
      ]),
    },
  ]);
  expectPair(result, 'resources.index', 'shared_salt', SHORT);
  expectSecret(result, 'resources.index', SHORT);
  expect(result.scan.hits.some((hit) => hit.match === '$string:16777217')).toBe(false);
}, 30_000);

it.each(['missing', 'cycle'] as const)(
  '[AC-QA-09d-HAP#10] resources.index 的签名资源引用 %s 必须 fail-closed',
  async (kind) => {
    const result = await inspect('hap', [
      { name: 'module.json', data: moduleJson([]) },
      {
        name: 'resources.index',
        data: resourcesIndex([
          { id: 0x01000000, name: 'shared_salt', value: '$string:16777217' },
          ...(kind === 'cycle'
            ? [{ id: 0x01000001, name: 'build_value', value: '$string:16777216' }]
            : []),
        ]),
      },
    ]);
    expectUnreadable(result, 'resources.index');
  },
  30_000,
);
