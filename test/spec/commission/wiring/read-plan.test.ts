import { expect, it, vi } from 'vitest';
import {
  createWiredConversion,
  type WiredLinkOpenOptions,
} from '../../../../apps/api/src/modules/linking/application/link-open-wiring.ts';
import { createLinkOpenRequote } from '../../../../apps/api/src/modules/linking/application/link-open-requote.ts';
import { conversionFixture, owner, LINK, USER_A, USER_B } from '../../linking/open-jdpdd/kit.ts';
import { fixture as requoteFixture } from '../../linking/open-requote/kit.ts';
import { plan, wiringFixture, type ReadPlan } from './kit.ts';

it('[AC-B2-03d#13] conversion.prepare 原样传完整计划给 quoteReads，失败留到事务内消费', async () => {
  const f = conversionFixture();
  const prepare = vi.fn(async (_plan: ReadPlan): Promise<void> => {
    void _plan;
    throw new Error('synthetic read failed');
  });
  const options = {
    ...f.options,
    environment: {
      appEnv: 'test',
      apps: {
        apps: {
          jd: {
            status: 'candidate',
            ios: { query_schemes: [] },
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
      },
      verifiedPaths: {},
    },
    cache: { get: vi.fn(async () => null), put: vi.fn(async () => undefined) },
    quoteReads: { prepare },
  } as unknown as WiredLinkOpenOptions;
  const wired = createWiredConversion(options);
  const input = plan({ platform: 'jd' });
  await expect(wired.conversion.prepare(input)).resolves.toBeUndefined();
  expect(prepare).toHaveBeenCalledExactlyOnceWith(input);
  expect(prepare.mock.calls[0]![0]).toBe(input);
});

it('[AC-B2-03d#14] 打开他人分享链接：预读计划保留归属用户，另带实际调用方 userId', async () => {
  const f = wiringFixture();
  const stored = owner('jd').link;
  const shared = {
    ...stored,
    scene: 'share',
    pid_scene: 'share',
    identity_snapshot: { ...owner('jd').identitySnapshot, pid_scene: 'share' },
  };
  // A compile-only DB supplies the one read of links. The idempotency boundary stops before
  // its handler; this test inspects preparation only and performs no transaction or writes.
  const db = f.db.withPlugin({
    transformQuery: ({ node }) => node,
    transformResult: async () => ({ rows: [shared] }),
  });
  const r = requoteFixture(db, { userId: USER_B });
  const prepare = vi.fn(async (_plan: ReadPlan) => {
    void _plan;
  });
  const boundary = new Error('synthetic transaction boundary');
  r.executeInTransaction.mockRejectedValue(boundary);
  const options = {
    ...r.options,
    conversion: { ...r.options.conversion, prepare },
  } as unknown as Parameters<typeof createLinkOpenRequote>[0];
  const service = createLinkOpenRequote(options);
  await expect(service.open(r.request(LINK))).rejects.toBe(boundary);
  expect(prepare).toHaveBeenCalledExactlyOnceWith({
    appId: shared.app_id,
    platform: 'jd',
    callerUserId: USER_B,
    identities: [{ userId: USER_A, pidScene: 'share', noRebate: false }],
  });
  expect(r.executeInTransaction).toHaveBeenCalledTimes(1);
});
