import { expect, it } from 'vitest';
import { UnionError } from '../../domain/types.ts';
import { checkShareLink, checkSpreadLink, parseShareCode, parseShortLink } from './links.ts';

function code(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof UnionError) return error.code;
    throw error;
  }
  throw new Error('expected a UnionError');
}

const SHORT = 'https://s.click.taobao.com/UnitShort1';

it('[AC-B1-04l-UNIT#7] 短链 results 缺失、非对象、tbk_spread 为空数组或非数组 → upstream_unavailable（UnionError）', () => {
  const bad: unknown[] = [
    {},
    { results: null },
    { results: [] },
    { results: {} },
    { results: { tbk_spread: [] } },
    { results: { tbk_spread: {} } },
    { results: { tbk_spread: 'unit' } },
    { results: { tbk_spread: [null] } },
    { results: { tbk_spread: [{ content: 42, err_msg: 'OK' }] } },
    null,
  ];
  for (const inner of bad) expect(code(() => parseShortLink(inner))).toBe('upstream_unavailable');
});

it('[AC-B1-04l-UNIT#8] 短链 err_msg 缺失 / 非 OK、content 缺失 → upstream_rejected；合格返回 content', () => {
  for (const item of [{ content: SHORT }, { err_msg: 'OK' }, { content: SHORT, err_msg: 'ok' }]) {
    expect(code(() => parseShortLink({ results: { tbk_spread: [item] } }))).toBe(
      'upstream_rejected',
    );
  }
  expect(parseShortLink({ results: { tbk_spread: [{ content: SHORT, err_msg: 'OK' }] } })).toBe(
    SHORT,
  );
});

it('[AC-B1-04l-UNIT#9] 淘口令空串字段 → upstream_unavailable', () => {
  for (const data of [
    { password_simple: '', model: 'unit' },
    { password_simple: 'unit', model: '' },
  ]) {
    expect(code(() => parseShareCode({ data }))).toBe('upstream_unavailable');
  }
});

it('[AC-B1-04l-UNIT#10] 链接白名单拒绝端口、用户信息、大写主机、空白与非字符串', () => {
  for (const bad of [
    'https://s.click.taobao.com:8443/t',
    'https://user@s.click.taobao.com/t',
    'https://S.CLICK.TAOBAO.COM/t',
    'https://s.click.taobao.com/t x',
    ' https://s.click.taobao.com/t',
    42,
  ]) {
    expect(code(() => checkShareLink(bad))).toBe('invalid_dto');
    expect(code(() => checkSpreadLink(bad))).toBe('invalid_dto');
  }
  expect(checkSpreadLink('https://ai.taobao.com')).toBe('https://ai.taobao.com');
});
