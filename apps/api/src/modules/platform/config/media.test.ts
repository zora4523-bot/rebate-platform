import { expect, it } from 'vitest';
import { MEDIA_DEFAULT_LOCAL_BASE_URL, readMediaConfig } from './media.ts';

it('[AC-F1-06z] unset or empty: local / test default, staging / prod undefined, no problem', () => {
  for (const raw of [undefined, '']) {
    const env = { MEDIA_PUBLIC_BASE_URL: raw };
    expect(readMediaConfig('local', env)).toEqual({
      mediaPublicBaseUrl: MEDIA_DEFAULT_LOCAL_BASE_URL,
      problems: [],
    });
    expect(readMediaConfig('test', env).mediaPublicBaseUrl).toBe(MEDIA_DEFAULT_LOCAL_BASE_URL);
    expect(readMediaConfig('staging', env)).toEqual({
      mediaPublicBaseUrl: undefined,
      problems: [],
    });
    expect(readMediaConfig('prod', env)).toEqual({ mediaPublicBaseUrl: undefined, problems: [] });
    expect(readMediaConfig(undefined, env).problems).toEqual([]);
  }
});

it('[AC-F1-06z] accepts absolute https URLs with optional path, port and trailing slash', () => {
  for (const raw of [
    'https://cdn.example.invalid',
    'https://cdn.example.invalid/',
    'https://cdn.example.invalid:8443/media/v1/',
  ]) {
    expect(readMediaConfig('prod', { MEDIA_PUBLIC_BASE_URL: raw })).toEqual({
      mediaPublicBaseUrl: raw,
      problems: [],
    });
  }
});

it('[AC-F1-06z] rejects other forms without echoing the value', () => {
  for (const raw of [
    'http://cdn.example.invalid',
    'HTTPS://cdn.example.invalid',
    'ftp://cdn.example.invalid',
    '/media',
    '//cdn.example.invalid',
    'https://',
    'https://user:secret-marker@cdn.example.invalid',
    ' https://cdn.example.invalid',
    'https://cdn.example.invalid/a b',
    'https://cdn.example.invalid?',
    'https://cdn.example.invalid/#x',
  ]) {
    const result = readMediaConfig('local', { MEDIA_PUBLIC_BASE_URL: raw });
    expect(result.mediaPublicBaseUrl, raw).toBeUndefined();
    expect(result.problems, raw).toHaveLength(1);
    expect(result.problems[0]).toMatch(/^MEDIA_PUBLIC_BASE_URL: /);
    expect(result.problems[0]).not.toContain('secret-marker');
  }
});
