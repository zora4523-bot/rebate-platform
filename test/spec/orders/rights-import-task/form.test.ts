// 契约 adminCreateRightsImport 的表单组合（AdminRightsImportByOrder / AdminRightsImportChannel）：
// 每个不合的组合 20001，data.fields 只点名那一项；文件由用例另判（create.int.test.ts）。
// 用例全部是顶层 it（资金 / 归属测试路径，规划/11 §4.3）。
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  checkRightsImportForm,
  countRightsImportRows,
  type RightsImportFormFields,
} from '../../../../apps/api/src/modules/orders/domain/rights-import.ts';

const FROM = '2026-10-01T00:00:00+08:00';
const TO = '2026-11-01T00:00:00+08:00';
const ACCOUNT = randomUUID();
const PLATFORMS = [
  'taobao',
  'jd',
  'pdd',
  'meituan',
  'vip',
  'douyin',
  'eleme',
  'kuaishou',
  'suning',
];

const refused = (fields: RightsImportFormFields, field: string) => {
  expect(checkRightsImportForm(fields)).toEqual({ ok: false, fields: [field] });
};

it.each([
  [{ platform: 'taobao' }, 'kind'],
  [{ kind: 'refund', platform: 'taobao' }, 'kind'],
  [{ kind: 'RIGHTS', platform: 'taobao' }, 'kind'],
  [{ kind: 'rights' }, 'platform'],
  [{ kind: 'rights', platform: 'alibaba' }, 'platform'],
  [{ kind: 'punish', platform: 'TAOBAO' }, 'platform'],
] as const)('[AC-B1-09g#1] kind 与 platform：%j → 20001 [%s]', (fields, field) => {
  refused(fields, field);
});

it.each(
  PLATFORMS.flatMap((platform) => [
    ['rights', platform],
    ['punish', platform],
  ]),
)('[AC-B1-09g#1] %s / %s 不带时间窗：受理，不筛行', (kind, platform) => {
  expect(checkRightsImportForm({ kind, platform })).toEqual({
    ok: true,
    form: { kind, platform, window: null },
  });
});

it.each(['rights', 'punish'])(
  '[AC-B1-09g#2] %s 带完整时间窗（time_basis、from、to）：受理，按 time_basis 筛行',
  (kind) => {
    for (const basis of ['paid', 'received']) {
      const result = checkRightsImportForm({
        kind,
        platform: 'jd',
        time_basis: basis,
        from: FROM,
        to: TO,
      });
      expect(result).toMatchObject({ ok: true, form: { kind, platform: 'jd' } });
      const form = result.ok ? result.form : undefined;
      const win = form !== undefined && 'window' in form ? form.window : null;
      expect(win?.time_basis).toBe(basis);
      expect(new Date(win?.from ?? '').getTime()).toBe(new Date(FROM).getTime());
      expect(new Date(win?.to ?? '').getTime()).toBe(new Date(TO).getTime());
    }
  },
);

it('[AC-B1-09g#2] 只带 time_basis：受理并忽略（不筛行）', () => {
  expect(
    checkRightsImportForm({ kind: 'rights', platform: 'pdd', time_basis: 'received' }),
  ).toEqual({ ok: true, form: { kind: 'rights', platform: 'pdd', window: null } });
});

it.each([
  [{ from: FROM, to: TO }, 'time_basis'],
  [{ time_basis: 'paid', from: FROM }, 'to'],
  [{ time_basis: 'paid', to: TO }, 'from'],
  [{ time_basis: 'shipped', from: FROM, to: TO }, 'time_basis'],
  [{ time_basis: 'paid', from: 'not-a-time', to: TO }, 'from'],
  [{ time_basis: 'paid', from: FROM, to: '2026-13-01T00:00:00+08:00' }, 'to'],
  [{ time_basis: 'received', from: '2026-10-01T00:00:00', to: TO }, 'from'],
  [{ union_account_id: ACCOUNT }, 'union_account_id'],
] as const)('[AC-B1-09g#2] rights 带 %j → 20001 [%s]', (patch, field) => {
  refused({ kind: 'rights', platform: 'taobao', ...patch }, field);
});

it.each([
  [FROM, FROM],
  [TO, FROM],
])('[AC-B1-09g#2] from=%s 不早于 to=%s：不受理（20001）', (from, to) => {
  const result = checkRightsImportForm({
    kind: 'punish',
    platform: 'taobao',
    time_basis: 'paid',
    from,
    to,
  });
  expect(result).toMatchObject({ ok: false });
  expect(result.ok ? [] : result.fields).not.toEqual([]);
});

it('[AC-B1-09g#3] 渠道单带 union_account_id：受理', () => {
  expect(
    checkRightsImportForm({ kind: 'channel', platform: 'taobao', union_account_id: ACCOUNT }),
  ).toEqual({
    ok: true,
    form: { kind: 'channel', platform: 'taobao', union_account_id: ACCOUNT },
  });
});

it.each([
  [{}, 'union_account_id'],
  [{ union_account_id: 'not-a-uuid' }, 'union_account_id'],
  [{ union_account_id: ACCOUNT, time_basis: 'paid' }, 'time_basis'],
  [{ union_account_id: ACCOUNT, from: FROM }, 'from'],
  [{ union_account_id: ACCOUNT, to: TO }, 'to'],
] as const)('[AC-B1-09g#3] channel 带 %j → 20001 [%s]', (patch, field) => {
  refused({ kind: 'channel', platform: 'jd', ...patch }, field);
});

it('[AC-B1-09g#4] 五项计数：total = 行数；每行只进 succeeded / failed / skipped / duplicate 之一', () => {
  expect(
    countRightsImportRows([
      { kind: 'succeeded' },
      { kind: 'failed', reason: 'order_not_found' },
      { kind: 'skipped' },
      { kind: 'duplicate' },
      { kind: 'succeeded' },
      { kind: 'failed', reason: 'invalid_row' },
      { kind: 'duplicate' },
    ]),
  ).toEqual({
    total_rows: 7,
    succeeded_rows: 2,
    failed_rows: 2,
    skipped_rows: 1,
    duplicate_rows: 2,
  });
});

it('[AC-B1-09g#4] 没有行：五项都是 0', () => {
  expect(countRightsImportRows([])).toEqual({
    total_rows: 0,
    succeeded_rows: 0,
    failed_rows: 0,
    skipped_rows: 0,
    duplicate_rows: 0,
  });
});
