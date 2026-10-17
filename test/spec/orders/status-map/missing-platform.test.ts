import { expect, it } from 'vitest';
import { loadStatusMap } from '../../../../apps/api/src/modules/orders/domain/status-map.ts';
import { DEMO_CSV, readStatusCsv } from './fixtures.ts';

it.each(['taobao', 'jd'] as const)(
  '[AC-B1-08f#11] BR-FUND-02：%s 尚无资料，不建映射表；缺表明确报 MISSING_STATUS_MAP',
  (platform) => {
    // 先触发骨架，再检查当前本来就不存在的资产，保证整条测试先红。
    const demo = loadStatusMap('demo', DEMO_CSV);
    expect(demo.entries.size).toBeGreaterThan(0);
    const csv = readStatusCsv(platform);
    expect(csv).toBeNull();
    // null 由启动时的读取层表示缺表；domain 自身不读取文件。
    expect(() => loadStatusMap(platform, csv)).toThrow(/MISSING_STATUS_MAP/);
  },
);
