import { expect, it } from 'vitest';
import { getMaterialChannels } from '../../../../apps/api/src/modules/platform/specs/material-channels.ts';
import { materialChannelsSource } from '../../../../apps/api/src/modules/platform/specs/scripts/generate-material-channels.ts';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';
import {
  generatedValue,
  platformExports,
  readGenerated,
  readSource,
  renderFixture,
  sourceFile,
} from './kit.ts';

it('[AC-CT-15m#6] material-channels 生成常量存在且与 YAML 全量一致，缺失或漂移必须失败', async () => {
  const value = generatedValue(await readGenerated('material-channels'), 'MATERIAL_CHANNELS');
  expect(value).toStrictEqual(await readSource('material-channels'));
});

it('[AC-CT-15m#7] material-channels 重新生成的文本与已入库文件逐字一致', async () => {
  const source = await materialChannelsSource(sourceFile('material-channels'));
  expect(await readGenerated('material-channels')).toBe(source);
});

// Synthetic channels only, not CAP evidence or an addition to the real whitelist.
const NONEMPTY_YAML = `version: '0009'
channels:
  - platform: pdd
    channel_id: '009'
    name: '合成样本 # 销量'
    sort_basis: sales
    selectable: true
    source: 'fixture: CAP-PDD-10（仅测试）'
  - platform: jd
    channel_id: '002'
    name: '合成不可选频道'
    sort_basis: popularity
    selectable: false
    source: 'fixture: CAP-JD-10（仅测试）'
  - platform: taobao
    channel_id: '001'
    name: '合成猜你喜欢频道'
    sort_basis: personalized
    selectable: true
    source: 'fixture: CAP-TB-10（仅测试）'
`;

it('[AC-CT-15m#8] material-channels 非空生成保留顺序、版本、频道 ID 和全部字段，不丢弃 false', async () => {
  const source = await renderFixture(materialChannelsSource, NONEMPTY_YAML);
  expect(generatedValue(source, 'MATERIAL_CHANNELS')).toStrictEqual(parseYamlLite(NONEMPTY_YAML));
});

it('[AC-CT-15m#9] material-channels 运行时取值与源规格一致', async () => {
  expect(getMaterialChannels()).toStrictEqual(await readSource('material-channels'));
});

it('[AC-CT-15m#10] platform/index.ts 提供 material-channels 常量及取值函数', async () => {
  const platform = await platformExports();
  expect(platform['MATERIAL_CHANNELS']).toStrictEqual(await readSource('material-channels'));
  expect(platform['getMaterialChannels']).toBe(getMaterialChannels);
  expect(getMaterialChannels()).toStrictEqual(platform['MATERIAL_CHANNELS']);
});
