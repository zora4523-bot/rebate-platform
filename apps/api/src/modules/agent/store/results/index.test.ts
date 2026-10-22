import { expect, it } from 'vitest';
import { cardLinkId, isCardId } from './index.ts';

it('[AC-B3-09c#8] card_id 只接受 c 加不以 0 开头的整数', () => {
  for (const ok of ['c1', 'c9', 'c10', 'c123']) expect(isCardId(ok)).toBe(true);
  for (const bad of ['c0', 'c01', 'C1', '1', 'c-1', 'c1.5', '', 'c1\n', ' c1']) {
    expect(isCardId(bad)).toBe(false);
  }
});

it('[AC-B3-09c#8] link_id 只取 data 顶层字符串', () => {
  expect(cardLinkId({ link_id: 'synthetic-link' })).toBe('synthetic-link');
  expect(cardLinkId({ nested: { link_id: 'synthetic-link' } })).toBeNull();
  expect(cardLinkId({ link_id: 42 })).toBeNull();
  expect(cardLinkId({ link_id: null })).toBeNull();
  expect(cardLinkId({})).toBeNull();
});
