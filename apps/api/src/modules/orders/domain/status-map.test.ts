import { describe, expect, it } from 'vitest';
import { loadStatusMap, mapPlatformStatus } from './status-map.ts';

const HEADER = 'raw_code,event,source,verified,note';

describe('status-map（单元）', () => {
  it('[AC-B1-08f#9] 去掉 UTF-8 BOM、空引号字段可解析', () => {
    const map = loadStatusMap('pdd', `\uFEFF${HEADER}\nx,PLATFORM_PAID,doc,false,""\n`);
    expect(map.entries.get('x')).toEqual({
      event: 'PLATFORM_PAID',
      source: 'doc',
      verified: false,
      note: '',
    });
  });

  it.each([
    ['只有表头', `${HEADER}\n`],
    ['中间空行', `${HEADER}\nx,PLATFORM_PAID,doc,false,a\n\ny,PLATFORM_PAID,doc,false,b\n`],
    ['引号未闭合', `${HEADER}\nx,PLATFORM_PAID,doc,false,"abc\n`],
    ['引号后跟杂字符', `${HEADER}\nx,PLATFORM_PAID,doc,false,"a"b\n`],
    ['空码', `${HEADER}\n,PLATFORM_PAID,doc,false,a\n`],
    ['空来源', `${HEADER}\nx,PLATFORM_PAID,,false,a\n`],
    ['多一列', `${HEADER}\nx,PLATFORM_PAID,doc,false,a,b\n`],
  ])('[AC-B1-08f#10] 拒绝坏表：%s', (_label, csv) => {
    expect(() => loadStatusMap('pdd', csv)).toThrow(/INVALID_STATUS_MAP/);
  });

  it('[AC-B1-08f#11] null 报 MISSING_STATUS_MAP', () => {
    expect(() => loadStatusMap('taobao', null)).toThrow(/MISSING_STATUS_MAP/);
  });

  it('[AC-B1-08f#8] 查找不做归一，原码原样返回', () => {
    const map = loadStatusMap('pdd', `${HEADER}\n5,PLATFORM_SETTLED,doc,false,a\n`);
    expect(mapPlatformStatus(map, '5 ')).toEqual({ kind: 'unmapped', rawCode: '5 ' });
  });
});
