import { describe, expect, it } from 'vitest';
import { appSchemeOf, buildDefaultLinkJump, type LinkOpenApps } from './link-open-conversion.ts';
import type { LinkOpenJump } from './link-open-requote.ts';
import { createJumpAdmission, type LinkOpenEnvironment } from './link-open-wiring.ts';

const apps: LinkOpenApps = {
  apps: {
    jd: {
      status: 'verified',
      ios: { query_schemes: ['synthetic-jd'] },
      android: { packages: [] },
      harmony: { query_schemes: [] },
    },
    pdd: {
      status: 'candidate',
      ios: { query_schemes: [] },
      android: { packages: [] },
      harmony: { query_schemes: [] },
    },
  },
};

const jump: LinkOpenJump = {
  primary: { type: 'scheme', value: 'synthetic-jd://virtual?params=x' },
  fallbacks: [
    { type: 'universal_link', value: 'https://example.test/u' },
    { type: 'h5', value: 'https://example.test/u' },
  ],
  expire_at: '2031-05-06T07:15:00.000Z',
};

function env(overrides: Partial<LinkOpenEnvironment>): LinkOpenEnvironment {
  return { appEnv: 'prod', apps, verifiedPaths: {}, ...overrides };
}

describe('jump-path admission (B1-06w)', () => {
  it('[AC-B1-06w] non-prod hands out the default matrix unchanged', () => {
    const admission = createJumpAdmission(env({ appEnv: 'staging' }));
    expect(admission.jump('jd', 'ios', jump)).toEqual(jump);
    expect(admission.page('jd', 'web', 'https://example.test/p')).toBe(true);
  });

  it('[AC-B1-06w] prod keeps only verified steps, in order, per platform and client', () => {
    const admission = createJumpAdmission(
      env({ verifiedPaths: { jd: { ios: ['h5', 'scheme'] } } }),
    );
    expect(admission.jump('jd', 'ios', jump)).toEqual({
      primary: jump.primary,
      fallbacks: [jump.fallbacks[1]],
      expire_at: jump.expire_at,
    });
    expect(admission.jump('jd', 'android', jump)).toBeNull();
    expect(admission.jump('pdd', 'ios', jump)).toBeNull();
    expect(admission.page('jd', 'ios', 'https://example.test/p')).toBe(true);
    expect(admission.page('jd', 'web', 'https://example.test/p')).toBe(false);
  });

  it('[AC-B1-06w] prod admits a scheme only under the verified apps.json scheme', () => {
    const candidate = createJumpAdmission(
      env({
        apps: { apps: { ...apps.apps, jd: { ...apps.apps.jd, status: 'candidate' } } },
        verifiedPaths: { jd: { ios: ['scheme'] } },
      }),
    );
    expect(candidate.jump('jd', 'ios', jump)).toBeNull();
    const verified = createJumpAdmission(env({ verifiedPaths: { jd: { ios: ['scheme'] } } }));
    const foreign: LinkOpenJump = {
      ...jump,
      primary: { type: 'scheme', value: 'synthetic-other://open' },
    };
    expect(verified.jump('jd', 'ios', foreign)).toBeNull();
  });
});

describe('app schemes from apps.json (B1-06w)', () => {
  it('[AC-B1-06w] the scheme is the declared one; none declared builds no scheme step', () => {
    expect(appSchemeOf(apps, 'jd')).toBe('synthetic-jd');
    expect(appSchemeOf(apps, 'pdd')).toBeNull();
    const plan = buildDefaultLinkJump({
      platform: 'pdd',
      client: 'ios',
      installed: 'true',
      paths: {
        scheme: null,
        universalLink: 'https://example.test/u',
        h5: 'https://example.test/u',
      },
      expireAt: jump.expire_at,
    });
    expect(plan).toEqual({
      primary: { type: 'h5', value: 'https://example.test/u' },
      fallbacks: [],
      expire_at: jump.expire_at,
    });
  });
});
