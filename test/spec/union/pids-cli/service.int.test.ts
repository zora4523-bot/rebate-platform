// 注入真实 B1-19b 服务、F1-06b super/TOTP 验证器及同一 audit_logs 写者。
// 仅容器集成环境执行；每个用例从 CLI 入口进入，不把骨架抛错当成预期拒绝。
import { createHmac } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { run } from '../../../../apps/api/scripts/union-pids.ts';
import { createUnionPidService } from '../../../../apps/api/src/modules/union/pids/service.ts';
import { createSuperVerifier } from '../../../../apps/api/src/modules/admin/application/verify-super.ts';
import { createAuditWriter } from '../../../../apps/api/src/modules/admin/infra/audit-writer.ts';
import { cryptoFixture } from '../../admin/totp/kit.ts';
import {
  harness,
  seedAdmin,
  seedAccount,
  seedPid,
  state,
  storedPid,
  audits,
  whitelist,
} from '../pids/kit.ts';
import { ACCOUNT, ADMIN, APP, EVIDENCE, EXPLICIT, PID, WRITES, argv, fixture } from './kit.ts';

let database: TestDatabase;
let db: Kysely<DB>;
beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
});
afterAll(async () => {
  if (db) await destroyDb(db);
  if (database) await database.drop();
});

// Independent RFC HOTP calculation using the public RFC test bytes, not the verifier under test.
function codeAt(instant: Date): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(instant.getTime() / 30_000)));
  const digest = createHmac('sha1', Buffer.from('12345678901234567890', 'ascii'))
    .update(counter)
    .digest();
  const offset = digest[digest.length - 1]! & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function realFixture() {
  const h = harness(db);
  await seedAdmin(h);
  const fields = await cryptoFixture();
  await db
    .updateTable('admin_users')
    .set({
      totp_bound_at: h.clock.now(),
      totp_secret_cipher: fields.encryptFor({ appId: h.appId, adminId: h.adminId }),
    })
    .where('id', '=', h.adminId)
    .where('app_id', '=', h.appId)
    .execute();
  const verifier = createSuperVerifier({
    db,
    clock: h.clock,
    crypto: fields.crypto,
    activeStatus: 'active',
  });
  const verify = vi.fn(verifier.verify);
  const serviceDeps = {
    ...h.deps,
    superVerifier: { verify },
    auditWriter: (trx: Kysely<DB>) => createAuditWriter({ db: trx, clock: h.clock }),
  };
  const service = createUnionPidService(serviceDeps);
  const cli = fixture();
  cli.readCode.mockImplementation(async () => codeAt(h.clock.now()));
  const deps = { ...cli.deps, service, clock: h.clock };
  return { h, cli, deps, service, serviceDeps, verify };
}

async function prepare(
  f: Awaited<ReturnType<typeof realFixture>>,
  command: (typeof WRITES)[number],
) {
  let accountId = ACCOUNT;
  let pidId = PID;
  if (command.name === 'register-pid')
    accountId = (await seedAccount(f.h, { platform: 'taobao' })).id;
  if (['confirm-hjy', 'activate', 'retire'].includes(command.name)) {
    pidId = (await seedPid(f.h, { status: command.name === 'retire' ? 'active' : 'pending' })).id;
  }
  return argv(command).map((value) =>
    value === APP
      ? f.h.appId
      : value === ADMIN
        ? f.h.adminId
        : value === ACCOUNT
          ? accountId
          : value === PID
            ? pidId
            : value,
  );
}

for (const command of WRITES) {
  it(`[AC-B1-19c#26] ${command.name}: 新动态码与同一显式键重放不重复写业务及审计`, async () => {
    const f = await realFixture();
    const args = [
      ...(await prepare(f, command)),
      '--idempotency-key',
      EXPLICIT,
      ...(command.name === 'confirm-hjy' ? ['--confirmed-at', f.h.clock.now().toISOString()] : []),
    ];
    expect(await run(args, f.deps)).toEqual({ exitCode: 0 });
    const before = await state(f.h);
    f.h.clock.advanceMs(30_000);
    expect(await run(args, f.deps)).toEqual({ exitCode: 0 });
    expect(await state(f.h)).toEqual(before);
    expect(f.verify).toHaveBeenCalledTimes(2);
    expect(f.cli.readCode).toHaveBeenCalledTimes(2);
    expect(f.cli.newIdempotencyKey).not.toHaveBeenCalled();
    expect(f.cli.printed()).toContain(EXPLICIT);
  });

  it(`[AC-B1-19c#20] ${command.name}: 真 super/TOTP 通过后持久写入同一审计表`, async () => {
    const f = await realFixture();
    const args = await prepare(f, command);
    const code = codeAt(f.h.clock.now());
    expect(await run(args, f.deps)).toEqual({ exitCode: 0 });
    expect(f.verify).toHaveBeenCalledExactlyOnceWith({
      appId: f.h.appId,
      adminId: f.h.adminId,
      code,
    });
    const entries = await audits(f.h);
    const action = {
      'register-account': 'union.account.register',
      'register-pid': 'union.pid.register',
      'confirm-hjy': 'union.pid.confirm_hjy_ignore',
      activate: 'union.pid.activate',
      retire: 'union.pid.retire',
    }[command.name];
    // Audit action spelling belongs to the existing service, not a second CLI audit vocabulary.
    const expectedMethod = command.name === 'register-account' ? 'union_accounts:' : 'union_pids:';
    const entry = entries.find((row) => row.target?.startsWith(expectedMethod));
    expect(entry).toBeDefined();
    expect(entry!.action).toBe(action);
    expect(entry).toMatchObject({
      app_id: f.h.appId,
      admin_id: f.h.adminId,
      at: f.h.clock.now(),
      ip: null,
    });
    expect(entry!.after).not.toBeNull();
    expect(entries.filter((row) => row.target === entry!.target)).toHaveLength(1);
    expect(f.cli.printed()).not.toContain(code);
    expect(
      JSON.stringify(entries, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toContain(`"code":"${code}"`);
  });

  for (const refusal of [
    'ordinary',
    'wrong-code',
    'unbound',
    'inactive',
    'other-app',
    'replayed',
  ] as const) {
    it(`[AC-B1-19c#21] ${command.name}: ${refusal} 真验证失败，非零退出且业务与审计不变`, async () => {
      const f = await realFixture();
      const args = await prepare(f, command);
      if (refusal === 'ordinary') {
        await db
          .updateTable('admin_users')
          .set({ is_super: false })
          .where('id', '=', f.h.adminId)
          .execute();
      }
      if (refusal === 'unbound') {
        await db
          .updateTable('admin_users')
          .set({ totp_bound_at: null, totp_secret_cipher: null })
          .where('id', '=', f.h.adminId)
          .execute();
      }
      if (refusal === 'inactive') {
        await db
          .updateTable('admin_users')
          .set({ status: 'synthetic-disabled' })
          .where('id', '=', f.h.adminId)
          .execute();
      }
      if (refusal === 'wrong-code') {
        // Pick a six-digit value outside all three RFC acceptance-window candidates.
        const accepted = [-30_000, 0, 30_000].map((offset) =>
          codeAt(new Date(f.h.clock.now().getTime() + offset)),
        );
        const wrong = ['000000', '000001', '000002', '000003'].find(
          (candidate) => !accepted.includes(candidate),
        )!;
        f.cli.readCode.mockResolvedValue(wrong);
      }
      if (refusal === 'other-app') args[args.indexOf('--app') + 1] = `${f.h.appId}-other`;
      if (refusal === 'replayed') {
        expect(
          await f.verify({ appId: f.h.appId, adminId: f.h.adminId, code: codeAt(f.h.clock.now()) }),
        ).not.toBeNull();
        f.verify.mockClear();
      }
      const before = await state(f.h);
      expect((await run(args, f.deps)).exitCode).toBeGreaterThan(0);
      expect(await state(f.h)).toEqual(before);
      expect(f.verify).toHaveBeenCalledTimes(1);
      expect(f.cli.printed()).not.toContain(codeAt(f.h.clock.now()));
    });
  }

  it(`[AC-B1-19c#22] ${command.name}: 审计写后失败整笔回滚，CLI 不报告成功`, async () => {
    const f = await realFixture();
    const args = await prepare(f, command);
    const before = await state(f.h);
    let attempted = false;
    const service = createUnionPidService({
      ...f.serviceDeps,
      auditWriter: (trx) => {
        const writer = createAuditWriter({ db: trx, clock: f.h.clock });
        return {
          append: async (event) => {
            attempted = true;
            await writer.append(event);
            throw new Error('synthetic-audit-outage');
          },
        };
      },
    });
    expect((await run(args, { ...f.deps, service })).exitCode).toBeGreaterThan(0);
    expect(attempted).toBe(true);
    expect(await state(f.h)).toEqual(before);
    expect(f.cli.printed()).toContain(f.cli.newIdempotencyKey.mock.results[0]?.value);
  });
}

it.each(['taobao', 'jd', 'pdd'] as const)(
  '[AC-B1-19c#23] %s: 经 CLI 登记、补证据、激活、退役；白名单保留且停止新转链',
  async (platform) => {
    const f = await realFixture();
    const common = ['--app', f.h.appId, '--admin', f.h.adminId];
    let sequence = 0;
    const invoke = async (args: string[]) => {
      f.h.clock.advanceMs(30_000);
      const result = await run(
        [...args, ...common, '--idempotency-key', `synthetic-lifecycle-${++sequence}`],
        f.deps,
      );
      expect(result).toEqual({ exitCode: 0 });
    };
    await invoke([
      'register-account',
      '--platform',
      platform,
      '--account-name',
      'synthetic account',
      '--auth-status',
      'active',
    ]);
    const account = (await state(f.h)).accounts[0]!;
    const syntheticPid = platform === 'taobao' ? 'mm_000_000_000' : 'synthetic-cli-pid';
    await invoke([
      'register-pid',
      '--platform',
      platform,
      '--union-account-id',
      account.id,
      '--pid',
      syntheticPid,
      '--pid-scene',
      'self_buy',
      ...(platform === 'taobao' ? ['--site-id', '000'] : []),
    ]);
    const pid = (await state(f.h)).pids[0]!;
    expect(pid.status).toBe('pending');
    expect(pid.hjy_ignore_confirmed_at).toBeNull();
    expect(pid.hjy_ignore_evidence_path).toBeNull();
    expect(await f.service.isWhitelisted(whitelist(f.h, pid))).toBe(true);
    const query = {
      appId: f.h.appId,
      platform,
      pidScene: 'self_buy' as const,
      purpose: 'convert' as const,
    };
    expect(await f.service.getActivePid(query)).toBeNull();
    await invoke(['confirm-hjy', '--pid-id', pid.id, '--evidence-path', EVIDENCE]);
    expect((await storedPid(f.h, pid.id)).hjy_ignore_evidence_path).toBe(EVIDENCE);
    await invoke(['activate', '--pid-id', pid.id]);
    expect((await f.service.getActivePid(query))?.id).toBe(pid.id);
    await invoke(['retire', '--pid-id', pid.id]);
    expect((await storedPid(f.h, pid.id)).status).toBe('retired');
    expect(await f.service.getActivePid(query)).toBeNull();
    expect(await f.service.isWhitelisted(whitelist(f.h, pid))).toBe(true);
    expect(
      (await audits(f.h)).filter((entry) => entry.target === `union_pids:${pid.id}`),
    ).toHaveLength(4);
    expect(f.verify).toHaveBeenCalledTimes(5);
  },
);

it('[AC-B1-19c#24] 同键新动态码重试仅有一次账号与审计，不同参数同键冲突', async () => {
  const f = await realFixture();
  const args = [...(await prepare(f, WRITES[0])), '--idempotency-key', EXPLICIT];
  expect(await run(args, f.deps)).toEqual({ exitCode: 0 });
  const before = await state(f.h);
  f.h.clock.advanceMs(30_000);
  expect(await run(args, f.deps)).toEqual({ exitCode: 0 });
  expect(await state(f.h)).toEqual(before);
  expect(before.accounts).toHaveLength(1);
  expect(before.audits).toHaveLength(1);
  f.h.clock.advanceMs(30_000);
  args[args.indexOf('--account-name') + 1] = 'synthetic different account';
  expect((await run(args, f.deps)).exitCode).toBeGreaterThan(0);
  expect(await state(f.h)).toEqual(before);
  expect(f.verify).toHaveBeenCalledTimes(3);
});

it('[AC-B1-19c#25] CLI 不绕过缺证据与退役不可回活的服务拒绝', async () => {
  const f = await realFixture();
  const missing = await seedPid(f.h, {
    hjy_ignore_confirmed_at: null,
    hjy_ignore_evidence_path: null,
  });
  const retired = await seedPid(f.h, { status: 'retired' });
  const before = await state(f.h);
  for (const row of [missing, retired]) {
    f.h.clock.advanceMs(30_000);
    expect(
      (
        await run(
          [
            'activate',
            '--app',
            f.h.appId,
            '--admin',
            f.h.adminId,
            '--pid-id',
            row.id,
            '--idempotency-key',
            `synthetic-refusal-${row.id}`,
          ],
          f.deps,
        )
      ).exitCode,
    ).toBeGreaterThan(0);
  }
  expect(await state(f.h)).toEqual(before);
  expect(f.verify).toHaveBeenCalledTimes(2);
});
