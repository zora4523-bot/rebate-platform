import { expect, it } from 'vitest';
import { isAttrCode, isInviteCode } from '../domain/registration.ts';
import { createDefaultInviteCodeFilter } from '../application/registration.ts';
import {
  loadInviteCodeSensitiveWords,
  parseInviteCodeSensitiveWords,
} from './invite-code-sensitive-words.ts';
import { newAttrCode, newInviteCode } from './registration-codes.ts';

it('[BR-INV-01][BR-ATTR-06] default candidates have the code formats and vary', () => {
  const invites = Array.from({ length: 200 }, () => newInviteCode());
  const attrs = Array.from({ length: 200 }, () => newAttrCode());
  for (const code of invites) expect(isInviteCode(code)).toBe(true);
  for (const code of attrs) expect(isAttrCode(code)).toBe(true);
  expect(new Set(invites).size).toBeGreaterThan(190);
  expect(new Set(attrs).size).toBeGreaterThan(190);
});

it('[BR-INV-01] the seed list loads, is non-empty and backs the default filter', () => {
  const words = loadInviteCodeSensitiveWords();
  expect(words.length).toBeGreaterThan(0);
  const filter = createDefaultInviteCodeFilter();
  for (const word of words)
    expect(filter.matches('invite_code', `2${word.toLowerCase()}9`)).toBe(true);
  expect(filter.matches('invite_code', '234567')).toBe(false);
});

it('[BR-INV-01] a missing or empty seed list stops the caller', () => {
  expect(() => parseInviteCodeSensitiveWords('# only a comment\n\n')).toThrow(
    /must name at least one word/,
  );
  expect(parseInviteCodeSensitiveWords('# c\nAB\n')).toEqual(['AB']);
  expect(() =>
    loadInviteCodeSensitiveWords(new URL('./no-such-file.txt', import.meta.url)),
  ).toThrow();
});
