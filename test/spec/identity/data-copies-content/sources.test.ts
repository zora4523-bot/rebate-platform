// B1-27f (08 BR-ID-40 细则「导出范围（默认）」; brief §9 「identity 自有部分自己实现，其余由各模块只读文件经
// index 导出、app.module 组装」): without a database. identity's createPersonalDataCopySources hands the
// five owner sections through unchanged and reads its own three; app.module's assembly reads every
// section with plain SELECTs scoped by app_id and the member, over a Kysely that compiles and
// records each statement but never connects (every read comes back empty).
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { PersonalDataCopySources } from '../../../../apps/api/src/modules/identity/ports/personal-data-copy-sources.ts';
import {
  NOW,
  SECTIONS,
  appModule,
  binds,
  compileOnlyDb,
  fieldCrypto,
  identity,
  isPlainRead,
  type Statement,
} from './kit.ts';

const SUBJECT = Object.freeze({
  appId: 'pdc_unit_app',
  userId: '3f0c6a52-2b1e-4c55-9d3a-6c1d2f8e9a10',
});

const OWNER_SECTIONS = ['orders', 'ledger', 'withdrawals', 'agent', 'invite'] as const;

/** The five owner reads as spies; each answers with its own object (compared by identity). */
function ownerReads() {
  const answers = {
    orders: [],
    ledger: [],
    withdrawals: [],
    agent: [],
    invite: { has_inviter: true },
  };
  const reads = {
    orders: vi.fn<PersonalDataCopySources['orders']>(async () => answers.orders),
    ledger: vi.fn<PersonalDataCopySources['ledger']>(async () => answers.ledger),
    withdrawals: vi.fn<PersonalDataCopySources['withdrawals']>(async () => answers.withdrawals),
    agent: vi.fn<PersonalDataCopySources['agent']>(async () => answers.agent),
    invite: vi.fn<PersonalDataCopySources['invite']>(async () => answers.invite),
  };
  return { answers, reads };
}

it('[AC-B1-27f#12] identity 把 orders / ledger / withdrawals / agent / invite 五段原样转交给 app.module 给的读：同一句柄、同一主体、结果原样返回，自己不发语句', async () => {
  const api = await identity();
  const { answers, reads } = ownerReads();
  const sources = api.createPersonalDataCopySources({ crypto: await fieldCrypto(), ...reads });
  const statements: Statement[] = [];
  const handle = compileOnlyDb(statements);
  for (const section of OWNER_SECTIONS) {
    const result = await sources[section](handle, { ...SUBJECT });
    expect(result, section).toBe(answers[section]);
    const read = reads[section];
    expect(read, section).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[0], section).toBe(handle);
    expect(read.mock.calls[0]?.[1], section).toEqual(SUBJECT);
  }
  expect(statements).toEqual([]);
});

it('[AC-B1-27f#13] identity 自己的账号资料、实名、同意记录：只发按 app_id 与本人取数、不加锁的 SELECT；查无数据时账号为 null、实名为 none、同意记录为空，不去调用五段的读', async () => {
  const api = await identity();
  const { reads } = ownerReads();
  const sources = api.createPersonalDataCopySources({ crypto: await fieldCrypto(), ...reads });
  const expected = {
    account: null,
    realname: { status: 'none', masked_name: null, masked_id_no: null, verified_at: null },
    consents: [],
  };
  for (const section of ['account', 'realname', 'consents'] as const) {
    const statements: Statement[] = [];
    expect(await sources[section](compileOnlyDb(statements), SUBJECT), section).toEqual(
      expected[section],
    );
    expect(statements.length, `${section} issued no statement`).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(isPlainRead(statement), `${section}: ${statement.sql}`).toBe(true);
      expect(binds(statement, SUBJECT.appId), `${section} not scoped by app_id`).toBe(true);
      expect(binds(statement, SUBJECT.userId), `${section} not scoped by the member`).toBe(true);
    }
  }
  for (const section of OWNER_SECTIONS) expect(reads[section], section).not.toHaveBeenCalled();
});

it('[AC-B1-27f#14] app.module 组装的八段都只发按 app_id 取数、不加锁的 SELECT，每段都按本人取；查无数据时账号为 null、实名为 none、各列表为空、未绑邀请人', async () => {
  const { personalDataCopySources } = await appModule();
  const sources = personalDataCopySources(new FixedClock(NOW), await fieldCrypto());
  const expected = {
    account: null,
    realname: { status: 'none', masked_name: null, masked_id_no: null, verified_at: null },
    consents: [],
    orders: [],
    ledger: [],
    withdrawals: [],
    agent: [],
    invite: { has_inviter: false },
  };
  for (const section of SECTIONS) {
    const statements: Statement[] = [];
    expect(await sources[section](compileOnlyDb(statements), SUBJECT), section).toEqual(
      expected[section],
    );
    expect(statements.length, `${section} issued no statement`).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(isPlainRead(statement), `${section}: ${statement.sql}`).toBe(true);
      expect(binds(statement, SUBJECT.appId), `${section} not scoped by app_id`).toBe(true);
    }
    expect(
      statements.some((statement) => binds(statement, SUBJECT.userId)),
      `${section} never names the member`,
    ).toBe(true);
  }
});
