import { expect, it } from 'vitest';
import { inspectPopupAsset } from '../../../../apps/api/src/modules/content/domain/popup-asset.ts';
import { lottie } from '../popup-assets/fixtures.ts';

// F1-09s §9.2–9.3 / BR-TEXT-26：先判秒数，再换算毫秒。
// 每组同时检查溢出反例与相邻回归；soft 断言让所有输入都被检查。
// 直接复用已有公开函数，不为先红而替换已有实现或引入测试专用入口。
it('[AC-F1-09s#1] 合法时长在普通、极大及极小帧率下均返回准确的有限正整数毫秒', () => {
  const cases = [
    { name: '普通 2.4 秒，扣除非零 ip', patch: { fr: 30, ip: 30, op: 102 }, ms: 2400 },
    { name: '恰好 3 秒', patch: { fr: 30, ip: 30, op: 120 }, ms: 3000 },
    { name: '2.9996 秒舍入到 3000 ms', patch: { fr: 10_000, ip: 0, op: 29_996 }, ms: 3000 },
    { name: '正常四舍五入', patch: { fr: 60, ip: 0, op: 1 }, ms: 17 },
    // frames * 1000 会溢出，但 frames / fr 为 1；不能一概拒收或夹到 3000。
    { name: '极大数的合法 1 秒', patch: { fr: 1e308, ip: 0, op: 1e308 }, ms: 1000 },
    { name: '极大数的合法 0.5 秒', patch: { fr: 1e308, ip: 0, op: 5e307 }, ms: 500 },
    { name: '极大数扣除非零 ip', patch: { fr: 5e307, ip: 5e307, op: 1e308 }, ms: 1000 },
    { name: '极小数的合法 1 秒', patch: { fr: 1e-308, ip: 0, op: 1e-308 }, ms: 1000 },
  ];

  for (const { name, patch, ms } of cases) {
    const result = inspectPopupAsset('lottie', lottie(patch));
    expect.soft(result, name).toMatchObject({ ok: true, format: 'json', durationMs: ms });
    if (result.ok) {
      expect.soft(Number.isFinite(result.durationMs), name).toBe(true);
      expect.soft(Number.isInteger(result.durationMs), name).toBe(true);
      expect.soft(result.durationMs, name).toBeGreaterThan(0);
      expect.soft(result.durationMs, name).toBeLessThanOrEqual(3000);
    }
  }
});

it('[AC-F1-09s#2] 帧差或秒数溢出以及超长动画均拒收 too_long，不能夹到 3000 ms', () => {
  const cases = [
    // 全部输入字段有限，但 op - ip 和 3 * fr 都变为 Infinity；旧比较漏拒收。
    { name: '帧差溢出，即使实数时长为 2 秒也拒收', fr: 1e308, ip: -1e308, op: 1e308 },
    { name: '帧差及上限溢出的超长动画', fr: 6e307, ip: -1e308, op: 1e308 },
    { name: '负向帧差溢出', fr: 1e308, ip: 1e308, op: -1e308 },
    { name: '帧差有限、除以极小帧率后秒数溢出', fr: 1e-308, ip: 0, op: 10 },
    { name: '极大帧差除以极小帧率', fr: 1e-308, ip: 0, op: 1e308 },
    { name: '有限秒数在换算毫秒时会溢出', fr: 1, ip: 0, op: 1e308 },
    { name: '3.0004 秒不能先舍入到 3000 ms 再放行', fr: 10_000, ip: 0, op: 30_004 },
    { name: '零时长', fr: 1e308, ip: 1e308, op: 1e308 },
    { name: '正时长舍入为零毫秒', fr: 10_000, ip: 0, op: 1 },
  ];

  for (const { name, ...patch } of cases) {
    expect.soft(inspectPopupAsset('lottie', lottie(patch)), name).toEqual({
      ok: false,
      reason: 'too_long',
    });
  }
});

it('[AC-F1-09s#3] 溢出输入仍遵守 too_large → format → too_long → external_ref 的拒收顺序', () => {
  const overflow = { fr: 1e308, ip: -1e308, op: 1e308, assets: [{ p: 'images/a.png' }] };
  const cases = [
    {
      name: '过大优先于结构错误、溢出与外部引用',
      bytes: lottie({ ...overflow, v: false }, 307_201),
      reason: 'too_large',
    },
    {
      name: '结构错误优先于溢出与外部引用',
      bytes: lottie({ ...overflow, v: false }),
      reason: 'format',
    },
    {
      name: '时长溢出优先于外部引用',
      bytes: lottie(overflow),
      reason: 'too_long',
    },
    {
      name: '极大数的合法 1 秒仍检查外部引用',
      bytes: lottie({ ...overflow, ip: 0 }),
      reason: 'external_ref',
    },
  ];

  for (const { name, bytes, reason } of cases) {
    expect.soft(inspectPopupAsset('lottie', bytes), name).toEqual({ ok: false, reason });
  }
});
