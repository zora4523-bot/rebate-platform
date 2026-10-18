import { expect, it } from 'vitest';
import { maskName } from '../domain/mask-name.ts';
import {
  FAKE_REALNAME_PROVIDER,
  createFakeRealnameVerifier,
  createRealnameVerifier,
} from './fake-realname-verifier.ts';

it('[BR-ID-33] maskName keeps only the last code point', () => {
  expect(maskName('欧阳小明')).toBe('***明');
  expect(maskName('李四')).toBe('*四');
  expect(maskName('王')).toBe('*');
  expect(maskName('')).toBe('');
  expect(maskName('𠀀𠀁')).toBe('*𠀁');
});

it('[BR-ID-25] the fake verifier is local / test only and answers a match', async () => {
  for (const env of ['local', 'test']) {
    await expect(
      createRealnameVerifier(env)!.verify({ app_id: 'a', user_id: 'u', name: 'n', id_no: 'i' }),
    ).resolves.toEqual({ outcome: 'match', provider: FAKE_REALNAME_PROVIDER });
  }
  for (const env of ['staging', 'prod']) {
    expect(createRealnameVerifier(env)).toBeNull();
    expect(() => createFakeRealnameVerifier(env)).toThrow(/local or test/);
  }
});
