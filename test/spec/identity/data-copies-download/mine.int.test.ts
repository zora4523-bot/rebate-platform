// B1-27i · the App's DataCopy page (08 BR-ID-40 细则「在 App 内下载」「副本请求与注销状态」; contract
// listMyDataCopies / getMyDataCopyDownload; task §9 ④): the list holds only the caller's own
// in_app_sms requests in ready / delivered whose expires_at has not come, newest generated first;
// a download signs a new link each time, valid min(5 minutes, expires_at), no-store, without the
// extraction code; anything else is one 30701 for every case. Usable while banned or appealing
// (10006 whitelist), in the deletion cooling period and on a deletion_only session of a client
// below the minimum version; once the deletion is processing or done nothing is listed or signed.
import { randomUUID } from 'node:crypto';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { validate } from './schema.ts';
import {
  close,
  copy,
  deletion,
  expectLinkTo,
  itemOf,
  itemsOf,
  linked,
  listed,
  member,
  ms,
  notFound,
  open,
  risk,
  DAY_MS,
  HOUR_MS,
  LINK_MS,
  MINUTE_MS,
  NOW,
  type Call,
  type CopyRow,
  type Kit,
  type Member,
} from './mine-kit.ts';

let database: TestDatabase;
let server: TestRedis;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  server = await acquireTestRedis();
  kit = await open(database, server);
}, 120_000);
beforeEach(() => {
  kit.clock.set(NOW);
});
afterAll(async () => {
  try {
    await close(kit);
  } finally {
    try {
      await server?.stop();
    } finally {
      await database?.drop();
    }
  }
}, 120_000);

const at = (offset: number) => new Date(kit.clock.now().getTime() + offset);

/** The owner can list exactly `expected` and download each of them. */
async function usable(owner: Member, expected: readonly CopyRow[], call: Call = {}) {
  expect(itemsOf(await listed(await owner.list(call)))).toEqual(expected.map(itemOf));
  for (const row of expected) {
    expectLinkTo(kit, await linked(await owner.download(row.id, call)), row);
  }
}

it('[AC-B1-27i#19] 列表只给本人 in_app_sms、ready / delivered、未过 expires_at 的副本，按生成时间新到旧；没有时 items=[]', async () => {
  const owner = await member(kit);
  const neighbour = await member(kit, { appId: owner.appId });
  const foreign = await member(kit);
  const empty = await member(kit, { appId: owner.appId });

  const older = await copy(kit, owner, { generatedAt: at(-5 * HOUR_MS) });
  const newer = await copy(kit, owner, { generatedAt: at(-2 * HOUR_MS) });
  const ready = await copy(kit, owner, { status: 'ready', generatedAt: at(-30 * MINUTE_MS) });
  // expires_at 1 ms from now: still listed.
  const edge = await copy(kit, owner, { generatedAt: at(1 - DAY_MS), expiresAt: at(1) });
  // Not listed: expires_at has come (status not changed yet), passed, the WeCom path, ended ones.
  await copy(kit, owner, { generatedAt: at(-DAY_MS), expiresAt: at(0) });
  await copy(kit, owner, { generatedAt: at(-DAY_MS - HOUR_MS), expiresAt: at(-HOUR_MS) });
  await copy(kit, owner, { delivery: 'wecom_session', generatedAt: at(-HOUR_MS) });
  for (const status of ['expired', 'failed', 'cancelled'] as const) {
    await copy(kit, owner, { status });
  }
  const theirs = await copy(kit, neighbour);
  const elsewhere = await copy(kit, foreign);

  expect(itemsOf(await listed(await owner.list()))).toEqual(
    [ready, newer, older, edge].map(itemOf),
  );
  expect(itemsOf(await listed(await neighbour.list()))).toEqual([itemOf(theirs)]);
  expect(itemsOf(await listed(await foreign.list()))).toEqual([itemOf(elsewhere)]);
  expect(await listed(await empty.list())).toEqual([]);
});

it('[AC-B1-27i#20] 下载现签短时链接：有效期 min(5 分钟, expires_at)、no-store、不带提取码，每次签新的；ready 也可下载', async () => {
  const owner = await member(kit);
  const delivered = await copy(kit, owner);
  const now = kit.clock.now().getTime();
  const first = await linked(await owner.download(delivered.id));
  expect(ms(first.url_expires_at)).toBe(now + LINK_MS);
  expectLinkTo(kit, first, delivered);

  kit.clock.advanceMs(1_000);
  const second = await linked(await owner.download(delivered.id));
  expect(second.url).not.toBe(first.url);
  expect(ms(second.url_expires_at)).toBe(now + 1_000 + LINK_MS);
  expectLinkTo(kit, second, delivered);

  // Less than 5 minutes left: the link ends at expires_at.
  const soon = await member(kit);
  const closing = await copy(kit, soon, {
    status: 'ready',
    generatedAt: at(2 * MINUTE_MS - DAY_MS),
    expiresAt: at(2 * MINUTE_MS),
  });
  const short = await linked(await soon.download(closing.id));
  expect(ms(short.url_expires_at)).toBe(ms(closing.expires_at));
  expectLinkTo(kit, short, closing);
});

it('[AC-B1-27i#21] 不存在、别人的、别的 app 的、企业微信路径的、状态不可下载的、已过 expires_at 的副本一律 30701，对外不区分', async () => {
  const owner = await member(kit);
  const neighbour = await member(kit, { appId: owner.appId });
  const foreign = await member(kit);
  const ids: string[] = [randomUUID()];
  ids.push((await copy(kit, neighbour)).id);
  ids.push((await copy(kit, foreign)).id);
  ids.push((await copy(kit, owner, { delivery: 'wecom_session' })).id);
  // The owner's one unfinished request: ready, but on the WeCom path.
  ids.push((await copy(kit, owner, { delivery: 'wecom_session', status: 'ready' })).id);
  for (const status of ['failed', 'expired', 'cancelled'] as const) {
    ids.push((await copy(kit, owner, { status })).id);
  }
  ids.push((await copy(kit, owner, { generatedAt: at(-DAY_MS), expiresAt: at(0) })).id);
  ids.push((await copy(kit, owner, { generatedAt: at(-DAY_MS - 1), expiresAt: at(-1) })).id);
  const bodies: Record<string, unknown>[] = [];
  for (const id of ids) bodies.push(await notFound(await owner.download(id)));
  // At most one open request per user (the owner's is the wecom_session one above): a pending and
  // a running request each belong to a user of their own, asked by that user.
  for (const status of ['pending', 'running'] as const) {
    const other = await member(kit);
    const unfinished = await copy(kit, other, { status });
    bodies.push(await notFound(await other.download(unfinished.id)));
  }
  for (const body of bodies) expect(body).toEqual(bodies[0]);
  // The owner's own listable copy still downloads (the refusals above were about the copies).
  const mine = await copy(kit, owner);
  expectLinkTo(kit, await linked(await owner.download(mine.id)), mine);
});

it.each(['banned', 'appealing'] as const)(
  '[AC-B1-27i#22] 封禁白名单：%s 的用户照常查列表、下载本人副本',
  async (state) => {
    const owner = await member(kit);
    const delivered = await copy(kit, owner);
    await risk(kit, owner, state);
    // The ban is in effect (GET /v1/me, itself on the whitelist, reports it).
    const me = await owner.get('/v1/me');
    expect(me.statusCode).toBe(200);
    expect(me.json<{ data: { risk: { state: string } } }>().data.risk.state).toBe(state);
    await usable(owner, [delivered]);
  },
);

it('[AC-B1-27i#23] 注销冷静期照常可用；版本过低的 deletion_only 受限会话同样可查、可下载', async () => {
  const cooling = await member(kit);
  const cooled = await copy(kit, cooling);
  await deletion(kit, cooling, 'cooling');
  await usable(cooling, [cooled]);

  const restricted = await member(kit);
  const kept = await copy(kit, restricted);
  await usable(restricted, [kept], { scope: 'deletion_only', version: '1.0.0' });
  await usable(restricted, [kept], { scope: 'deletion_only' });
});

it.each(['processing', 'done'] as const)(
  '[AC-B1-27i#24] 注销进入 %s 后不可用：即使请求还记着文件，列表为空、下载 30701',
  async (stage) => {
    const owner = await member(kit);
    const delivered = await copy(kit, owner);
    const unknown = await notFound(await owner.download(randomUUID()));
    await deletion(kit, owner, stage);
    expect(await listed(await owner.list())).toEqual([]);
    expect(await notFound(await owner.download(delivered.id))).toEqual(unknown);
  },
);

it('[AC-B1-27i#25] 要登录：不带令牌时列表与下载都回 401 / 10001', async () => {
  const owner = await member(kit);
  const delivered = await copy(kit, owner);
  for (const [key, response] of [
    ['list', await owner.list({ authenticated: false })],
    ['mine', await owner.download(delivered.id, { authenticated: false })],
  ] as const) {
    expect(response.statusCode, key).toBe(401);
    expect(response.json()).toMatchObject({ code: 10001 });
    await validate(response, key);
  }
});
