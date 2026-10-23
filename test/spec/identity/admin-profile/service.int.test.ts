// B1-27b · the use case on its own (application/admin-profile-edit.ts) over the real database:
// one transaction for the user fields, deleted_identities, the revocation and the audit row (any
// failure rolls all of it back); the content-safety review fails closed; the phone checks come
// before the review. Ports are the production ones (risk's blocklist, admin's audit writer,
// identity's revocation by user) unless a case replaces one to observe or break it.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expect, it } from 'vitest';
import { createAuditWriter } from '../../../../apps/api/src/modules/admin/infra/audit-writer.ts';
import {
  AdminProfileEdit,
  type AdminProfileEditCommand,
  type AdminProfileEditOptions,
} from '../../../../apps/api/src/modules/identity/application/admin-profile-edit.ts';
import { revokeSessionsByUser } from '../../../../apps/api/src/modules/identity/application/revoke-sessions.ts';
import { createLocalNicknameReview } from '../../../../apps/api/src/modules/identity/infra/nickname-review.ts';
import type {
  NicknameReviewInput,
  NicknameReviewPort,
  NicknameReviewVerdict,
} from '../../../../apps/api/src/modules/identity/ports/nickname-review.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { AuditInput } from '../../../../apps/api/src/modules/platform/audit/port.ts';
import { createBlocklistService } from '../../../../apps/api/src/modules/risk/index.ts';
import { seed } from '../../admin/accounts/kit.ts';
import { NOW, useHarness } from '../../admin/auth/kit.ts';
import { memoryLogger } from '../sms-codes/kit.ts';
import {
  ACTION,
  REASON,
  SEED_WORD,
  blocked,
  devices,
  hmacOf,
  row,
  sessionsOf,
  snapshot,
  testPhone,
  user,
} from './kit.ts';

const h = useHarness();

async function scene() {
  const clock = new FixedClock(NOW);
  const { logger } = memoryLogger();
  const appId = `b1-27b-svc-${randomUUID()}`;
  const admin = await seed(h, appId, { isSuper: true });
  const target = await user(h, appId);
  await devices(h, clock, target, 2);
  const reviews: NicknameReviewInput[] = [];
  const local = createLocalNicknameReview([SEED_WORD]);
  const review: NicknameReviewPort = {
    review: (input) => {
      reviews.push(input);
      return local.review(input);
    },
  };
  const options: AdminProfileEditOptions = {
    db: h.db,
    clock,
    logger,
    crypto: h.fields,
    review,
    blocklist: createBlocklistService({ db: h.db, clock, crypto: h.fields, logger }),
    auditOn: (trx) => createAuditWriter({ db: trx, clock }),
    revokeSessions: (trx, input) => revokeSessionsByUser(trx, input, clock),
  };
  const command = (body: AdminProfileEditCommand['body']): AdminProfileEditCommand => ({
    appId,
    adminId: admin.id,
    ip: '127.0.0.1',
    userId: target.id,
    body,
  });
  return { clock, appId, admin, target, reviews, options, command };
}

it('[AC-B1-27b#37] 审计写失败：整次保存回滚（号码、昵称、deleted_identities、会话都不变），错误向上抛', async () => {
  const sc = await scene();
  const failure = new Error('synthetic audit failure');
  const service = new AdminProfileEdit({
    ...sc.options,
    auditOn: () => ({ append: () => Promise.reject(failure) }),
  });
  const before = await snapshot(h, sc.appId);
  const body = { phone: testPhone(), nickname: '小狸', reason: REASON };
  const pending = service.edit(sc.command(body));
  await expect(pending).rejects.toBe(failure);
  expect(await snapshot(h, sc.appId)).toEqual(before);
});

it('[AC-B1-27b#38] 会话作废在保存的事务里：作废之后失败，作废与改号一起回滚', async () => {
  const sc = await scene();
  const failure = new Error('synthetic revocation failure');
  const service = new AdminProfileEdit({
    ...sc.options,
    revokeSessions: async (trx, input) => {
      await revokeSessionsByUser(trx, input, sc.clock);
      throw failure;
    },
  });
  const before = await snapshot(h, sc.appId);
  const pending = service.edit(sc.command({ phone: testPhone(), reason: REASON }));
  await expect(pending).rejects.toBe(failure);
  expect(await snapshot(h, sc.appId)).toEqual(before);
  for (const entry of await sessionsOf(h, sc.target)) expect(entry.revoked_at).toBeNull();
});

it('[AC-B1-27b#39] 改号时按用户作废一次（phone_changed）并记一条审计；只改昵称不作废', async () => {
  const sc = await scene();
  const revocations: unknown[] = [];
  const appended: AuditInput[] = [];
  const service = new AdminProfileEdit({
    ...sc.options,
    revokeSessions: (trx: Transaction<DB>, input) => {
      revocations.push(input);
      return revokeSessionsByUser(trx, input, sc.clock);
    },
    auditOn: (trx) => {
      const writer = createAuditWriter({ db: trx, clock: sc.clock });
      return {
        append: (input) => {
          appended.push(input);
          return writer.append(input);
        },
      };
    },
  });
  expect(await service.edit(sc.command({ phone: testPhone(), reason: REASON }))).toEqual({
    code: 0,
  });
  expect(revocations).toEqual([
    { app_id: sc.appId, user_id: sc.target.id, reason: 'phone_changed' },
  ]);
  const now = sc.clock.now();
  for (const entry of await sessionsOf(h, sc.target)) {
    expect(entry).toMatchObject({ revoked_at: now, revoke_reason: 'phone_changed' });
  }
  expect(appended).toHaveLength(1);
  expect(appended[0]).toMatchObject({
    appId: sc.appId,
    actor: sc.admin.id,
    action: ACTION,
    ip: '127.0.0.1',
  });
  const nickname = await service.edit(sc.command({ nickname: '小狸', reason: REASON }));
  expect(nickname).toEqual({ code: 0 });
  expect(revocations).toHaveLength(1);
  expect(appended).toHaveLength(2);
});

it.each<{ label: string; verdict: () => Promise<NicknameReviewVerdict> }>([
  { label: 'hit', verdict: () => Promise.resolve('hit') },
  { label: 'unavailable（超时或故障）', verdict: () => Promise.resolve('unavailable') },
  { label: 'throws', verdict: () => Promise.reject(new Error('review outage')) },
])(
  '[AC-B1-27b#40] 审核结果 $label 一律 fail-close：20001 nickname_sensitive，什么都不写；送审的是去空白后的昵称',
  async ({ verdict }) => {
    const sc = await scene();
    const calls: NicknameReviewInput[] = [];
    const service = new AdminProfileEdit({
      ...sc.options,
      review: {
        review: (input) => {
          calls.push(input);
          return verdict();
        },
      },
    });
    const before = await snapshot(h, sc.appId);
    const body = { phone: testPhone(), nickname: '  小狸  ', reason: REASON };
    expect(await service.edit(sc.command(body))).toEqual({
      code: 20001,
      data: { fields: ['nickname'], reason: 'nickname_sensitive' },
    });
    expect(calls).toEqual([{ appId: sc.appId, text: '小狸' }]);
    expect(await snapshot(h, sc.appId)).toEqual(before);
  },
);

it('[AC-B1-27b#41] 先查手机号再送审：号码不合规、命中黑名单或被占用时昵称不送审', async () => {
  const sc = await scene();
  const service = new AdminProfileEdit(sc.options);
  const listed = testPhone();
  await blocked(h, sc.clock, sc.appId, listed);
  const holder = await user(h, sc.appId);
  const before = await snapshot(h, sc.appId);
  const cases: [string | null, object][] = [
    ['12345', { code: 20001, data: { fields: ['phone'], reason: 'phone_invalid' } }],
    [listed, { code: 44001 }],
    [holder.phone, { code: 30411 }],
  ];
  for (const [phone, expected] of cases) {
    const body = { phone: phone!, nickname: '小狸', reason: REASON };
    expect(await service.edit(sc.command(body)), String(phone)).toEqual(expected);
  }
  expect(sc.reviews).toEqual([]);
  expect(await snapshot(h, sc.appId)).toEqual(before);
});

it('[AC-B1-27b#42] 未知用户与别的 App 的用户 → 20001 [user_id]，不送审、不写', async () => {
  const sc = await scene();
  const service = new AdminProfileEdit(sc.options);
  const foreign = await user(h, `foreign-${randomUUID()}`);
  const before = await snapshot(h, sc.appId);
  for (const userId of [randomUUID(), foreign.id]) {
    const command = { ...sc.command({ nickname: '小狸', reason: REASON }), userId };
    expect(await service.edit(command)).toEqual({ code: 20001, data: { fields: ['user_id'] } });
  }
  expect(sc.reviews).toEqual([]);
  expect(await snapshot(h, sc.appId)).toEqual(before);
  expect(await row(h, foreign)).toMatchObject({
    nickname: foreign.nickname,
    phone_hmac: hmacOf(h, foreign.phone!),
  });
});
