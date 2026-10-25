import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  MIN,
  NOW_MS,
  fields,
  iso,
  ok,
  setup,
  someFields,
  unionAccount,
  type Created,
  type Limits,
  type Scenario,
} from './kit.ts';

const h = useHarness();
const FROM = iso(NOW_MS - 180 * MIN);
const TO = iso(NOW_MS - 160 * MIN);
const BODY = ['platform', 'from', 'to', 'status_filter', 'order_nos', 'body'];
const numbers = (n: number) =>
  Array.from({ length: n }, (_, i) => `231006-${String(1_000_000_000 + i)}`);

/** A refused request leaves no row and sends no job. */
async function nothing(s: Scenario) {
  expect(await s.rows()).toEqual([]);
  expect(s.jobs()).toEqual([]);
}

/** The same scenario still accepts a valid request (the refusal was about the body). */
async function accepts(s: Scenario) {
  const created = await ok<Created>(
    await s.post({ platform: 'pdd', from: FROM, to: TO }),
    'create',
  );
  expect(created).toMatchObject({ status: 'queued', reused: false });
}

it('[AC-B1-09i#6] from 不早于 to（相等或倒置）→ 20001 fields=[from, to]，不建请求不投递', async () => {
  const s = await setup(h);
  await unionAccount(s, 'pdd');
  for (const [from, to] of [
    [FROM, FROM],
    [TO, FROM],
    ['2026-10-09T08:00:00+08:00', '2026-10-09T00:00:00.000Z'],
  ] as const) {
    await fields(await s.post({ platform: 'pdd', from, to }), 'create', ['from', 'to']);
  }
  await nothing(s);
  await accepts(s);
});

it('[AC-B1-09i#7] from 早于该平台 limits 的 earliest_from → 20001 fields=[from]；恰为 earliest_from 受理', async () => {
  const s = await setup(h);
  await unionAccount(s, 'pdd');
  const limits = await ok<Limits>(await s.limits(), 'limits');
  const pdd = limits.items.find((item) => item.platform === 'pdd');
  expect(pdd).toBeDefined();
  const earliest = Date.parse(pdd!.earliest_from);
  await fields(
    await s.post({ platform: 'pdd', from: iso(earliest - 1000), to: iso(earliest + 10 * MIN) }),
    'create',
    ['from'],
  );
  await nothing(s);
  const created = await ok<Created>(
    await s.post({ platform: 'pdd', from: iso(earliest), to: iso(earliest + 10 * MIN) }),
    'create',
  );
  expect(created).toMatchObject({ status: 'queued', reused: false });
});

it('[AC-B1-09i#8] order_nos 超过 50 个或为空 → 20001 fields=[order_nos]；恰好 50 个受理', async () => {
  const s = await setup(h);
  await unionAccount(s, 'pdd');
  await fields(await s.post({ platform: 'pdd', order_nos: numbers(51) }), 'create', ['order_nos']);
  await fields(await s.post({ platform: 'pdd', order_nos: [] }), 'create', ['order_nos']);
  await nothing(s);
  const created = await ok<Created>(
    await s.post({ platform: 'pdd', order_nos: numbers(50) }),
    'create',
  );
  expect(created).toMatchObject({ status: 'queued', reused: false });
  const [row] = await s.rows();
  expect(row).toMatchObject({ mode: 'order_nos', order_nos: numbers(50) });
});

it.each(['pdd', 'jd', 'taobao'] as const)(
  '[AC-B1-09i#9] %s 的 status_filter 未在 specs/union 登记（登记处为空）→ 20001 fields=[status_filter]',
  async (platform) => {
    const s = await setup(h);
    await unionAccount(s, 'pdd');
    if (platform !== 'pdd') await unionAccount(s, platform);
    for (const statusFilter of ['paid', 'settled', 'x'.repeat(64)]) {
      await fields(
        await s.post({ platform, from: FROM, to: TO, status_filter: statusFilter }),
        'create',
        ['status_filter'],
      );
    }
    await nothing(s);
    await accepts(s);
  },
);

it('[AC-B1-09i#10] 两种形式混用、缺形式、未知平台、非法时间都 20001 并点名字段；不建请求不投递', async () => {
  const s = await setup(h);
  await unionAccount(s, 'pdd');
  await someFields(
    await s.post({ platform: 'pdd', from: FROM, to: TO, order_nos: ['231006-1234567891'] }),
    'create',
    BODY,
  );
  await someFields(await s.post({ platform: 'pdd' }), 'create', BODY);
  await someFields(await s.post({}), 'create', BODY);
  for (const body of [
    { platform: 'nope', from: FROM, to: TO },
    { platform: 'nope', order_nos: ['231006-1234567891'] },
  ]) {
    const response = await s.post(body);
    await someFields(response, 'create', BODY);
    expect(response.json<{ data: { fields: string[] } }>().data.fields).toContain('platform');
  }
  for (const [from, to, field] of [
    ['yesterday', TO, 'from'],
    [FROM, '2026-13-01T00:00:00Z', 'to'],
  ] as const) {
    const response = await s.post({ platform: 'pdd', from, to });
    await someFields(response, 'create', BODY);
    expect(response.json<{ data: { fields: string[] } }>().data.fields).toContain(field);
  }
  await nothing(s);
  await accepts(s);
});
