// Rule tests for applyReserve (规划/08 BR-CALC-02: N_pos = max(0, N_base);
// after_rsv = floor(N_pos × (10000 − reserve_bp) / 10000); reserve_fen = N_pos − after_rsv).
// tlj_deduct_fen is not part of @couli/money (always 0 in the first version, BR-CALC-02 细则).
// Top-level it() only (规划/11 §4.3).
import { applyReserve, InvalidAmount, InvalidRatio } from '@couli/money';
import { expect, it } from 'vitest';

it('[BR-CALC-02] 例：N_base=1000、淘宝 reserve_bp=1500 → after_rsv=850、reserve_fen=150', () => {
  expect(applyReserve(1000n, 1500n)).toEqual({ after_reserve_fen: 850n, reserve_fen: 150n });
});

it('[BR-CALC-02] 例（尾差）：N_base=1452、reserve_bp=1500 → 1234，reserve_fen=218（尾差归平台，不是 B=1235）', () => {
  expect(applyReserve(1452n, 1500n)).toEqual({ after_reserve_fen: 1234n, reserve_fen: 218n });
});

it('[BR-CALC-02] 例：14.52 元、reserve_bp=0 → N_base=1452 → B=1452', () => {
  expect(applyReserve(1452n, 0n)).toEqual({ after_reserve_fen: 1452n, reserve_fen: 0n });
});

it('[BR-CALC-02] 公式：reserve_bp=1300（细则所举淘宝取值）、N_base=1000 → floor(1000×8700/10000)=870，reserve_fen=130', () => {
  expect(applyReserve(1000n, 1300n)).toEqual({ after_reserve_fen: 870n, reserve_fen: 130n });
});

it('[BR-CALC-02] N_base ≤ 0 时先置 0，reserve_fen = 0（联盟 N 为负 → B=0）', () => {
  expect([applyReserve(-320n, 1500n), applyReserve(0n, 1500n)]).toEqual([
    { after_reserve_fen: 0n, reserve_fen: 0n },
    { after_reserve_fen: 0n, reserve_fen: 0n },
  ]);
});

it('[BR-CALC-02] reserve_bp 取值 0–10000：reserve_bp=10000 → 全部归平台', () => {
  expect(applyReserve(1000n, 10000n)).toEqual({ after_reserve_fen: 0n, reserve_fen: 1000n });
});

it('[BR-CALC-02] reserve_bp 超界（10001、-1）或不是 bigint（1500 的 number）抛 InvalidRatio', () => {
  expect(() => applyReserve(1000n, 10001n)).toThrow(InvalidRatio);
  expect(() => applyReserve(1000n, -1n)).toThrow(InvalidRatio);
  expect(() => applyReserve(1000n, 1500 as unknown as bigint)).toThrow(InvalidRatio);
});

it('[BR-CALC-01] N_base 不是 bigint（number 1000、浮点 14.52）抛 InvalidAmount', () => {
  expect(() => applyReserve(1000 as unknown as bigint, 1500n)).toThrow(InvalidAmount);
  expect(() => applyReserve(14.52 as unknown as bigint, 1500n)).toThrow(InvalidAmount);
});
