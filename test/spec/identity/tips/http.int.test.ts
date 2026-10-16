import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  NOW,
  TIPS,
  READ,
  RESET,
  openKit,
  closeKit,
  fixture,
  client,
  accepted,
  envelope,
  states,
  at,
  type Kit,
  type Method,
} from './http-kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 120_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

it('[AC-B1-02s#1] 未读 GET 只返回空平台对象和 null，读取不产生已读行', async () => {
  const f = await fixture(kit);
  expect(states(kit, await f.get())).toEqual({ jump_tip: {}, inviter_before_buy: null });
  expect(states(kit, await f.get())).toEqual({ jump_tip: {}, inviter_before_buy: null });
  expect(await f.rows()).toEqual([]);
});

it('[AC-B1-02s#2] 两个平台各记 Clock 时刻，GET 只列已读平台', async () => {
  const f = await fixture(kit);
  accepted(kit, 'POST', await f.mark('jump_tip', { platform: 'taobao' }));
  kit.clock.advanceMs(1_234);
  const second = kit.clock.now().toISOString();
  accepted(kit, 'POST', await f.mark('jump_tip', { platform: 'jd' }));
  const data = states(kit, await f.get());
  expect(Object.keys(data.jump_tip).sort()).toEqual(['jd', 'taobao']);
  at(data.jump_tip['taobao']);
  at(data.jump_tip['jd'], second);
  expect(data.inviter_before_buy).toBeNull();
  expect(
    (await f.rows()).map(({ app_id, user_id, tip_key, platform, read_at }) => ({
      app_id,
      user_id,
      tip_key,
      platform,
      read_at: read_at.toISOString(),
    })),
  ).toEqual([
    { app_id: f.appId, user_id: f.uid, tip_key: 'jump_tip', platform: 'jd', read_at: second },
    { app_id: f.appId, user_id: f.uid, tip_key: 'jump_tip', platform: 'taobao', read_at: NOW },
  ]);
});

it('[AC-B1-02s#3] 重复 POST 回 0，推进 Clock 后原行及首次 read_at 不变', async () => {
  const f = await fixture(kit);
  accepted(kit, 'POST', await f.mark('jump_tip', { platform: 'taobao' }));
  const original = await f.rows();
  kit.clock.advanceMs(60_000);
  accepted(kit, 'POST', await f.mark('jump_tip', { platform: 'taobao' }));
  expect(await f.rows()).toEqual(original);
  at(states(kit, await f.get()).jump_tip['taobao']);
});

it('[AC-B1-02s#4] 同账号另一设备及会话读取相同提示状态', async () => {
  const f = await fixture(kit);
  accepted(kit, 'POST', await f.mark('jump_tip', { platform: 'taobao' }));
  accepted(kit, 'POST', await f.mark('inviter_before_buy'));
  const other = await client(kit, f.appId, f.uid);
  expect(other.deviceId).not.toBe(f.device.deviceId);
  expect(other.sid).not.toBe(f.device.sid);
  const expected = states(kit, await f.get());
  expect(states(kit, await other.request('GET', TIPS))).toEqual(expected);
  kit.clock.advanceMs(60_000);
  const original = await f.rows();
  accepted(
    kit,
    'POST',
    await other.request('POST', `${TIPS}/jump_tip/read`, { platform: 'taobao' }),
  );
  accepted(kit, 'POST', await other.request('POST', `${TIPS}/inviter_before_buy/read`));
  expect(await f.rows()).toEqual(original);
});

it('[AC-B1-02s#5] inviter_before_buy 无请求体可记已读，平台固定空串且 GET 不分平台', async () => {
  const f = await fixture(kit);
  accepted(kit, 'POST', await f.mark('inviter_before_buy'));
  const rows = await f.rows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    app_id: f.appId,
    user_id: f.uid,
    tip_key: 'inviter_before_buy',
    platform: '',
    read_at: new Date(NOW),
  });
  const data = states(kit, await f.get());
  expect(data.jump_tip).toEqual({});
  at(data.inviter_before_buy);
  kit.clock.advanceMs(60_000);
  accepted(kit, 'POST', await f.mark('inviter_before_buy'));
  expect(await f.rows()).toEqual(rows);
});

for (const [label, body] of [
  ['合法平台', { platform: 'jd' }],
  ['无平台及额外字段', { irrelevant: true }],
  ['非法平台', { platform: 'not-a-platform' }],
] as const) {
  it(`[AC-B1-02s#6] inviter_before_buy 首次及重复调用忽略请求体：${label}`, async () => {
    const f = await fixture(kit);
    accepted(kit, 'POST', await f.mark('inviter_before_buy', body));
    const original = await f.rows();
    expect(original).toHaveLength(1);
    expect(original[0]).toMatchObject({
      tip_key: 'inviter_before_buy',
      platform: '',
      read_at: new Date(NOW),
    });
    kit.clock.advanceMs(60_000);
    accepted(kit, 'POST', await f.mark('inviter_before_buy', body));
    expect(await f.rows()).toEqual(original);
    const data = states(kit, await f.get());
    expect(data.jump_tip).toEqual({});
    at(data.inviter_before_buy);
  });
}

for (const [label, body] of [
  ['无请求体', undefined],
  ['空对象', {}],
] as const) {
  it(`[AC-B1-02s#7] jump_tip ${label}返回 20001 且 fields 仅含 platform`, async () => {
    const f = await fixture(kit);
    expect(envelope(kit, 'POST', READ, await f.mark('jump_tip', body), 20001)).toEqual({
      fields: ['platform'],
    });
    expect(await f.rows()).toEqual([]);
  });
}

for (const platform of ['not-a-platform', 'ios', '', null, 1]) {
  it(`[AC-B1-02s#8] 非法购买平台 ${JSON.stringify(platform)} 返回 20001 且不落行`, async () => {
    const f = await fixture(kit);
    envelope(kit, 'POST', READ, await f.mark('jump_tip', { platform }), 20001);
    expect(await f.rows()).toEqual([]);
  });
}

it('[AC-B1-02s#9] POST 非法 tip_key 返回 20001 且不落行', async () => {
  const f = await fixture(kit);
  envelope(kit, 'POST', READ, await f.mark('unknown_tip', { platform: 'taobao' }), 20001);
  expect(await f.rows()).toEqual([]);
});

it('[AC-B1-02s#10] DELETE 清空全部 jump_tip 平台、保留邀请提示，再读后可按新 Clock 重新记录', async () => {
  const f = await fixture(kit);
  for (const platform of ['taobao', 'jd', 'pdd']) {
    accepted(kit, 'POST', await f.mark('jump_tip', { platform }));
  }
  accepted(kit, 'POST', await f.mark('inviter_before_buy'));
  const inviter = (await f.rows()).filter((row) => row.tip_key === 'inviter_before_buy');
  accepted(kit, 'DELETE', await f.reset());
  expect(await f.rows()).toEqual(inviter);
  const data = states(kit, await f.get());
  expect(data.jump_tip).toEqual({});
  at(data.inviter_before_buy);
  accepted(kit, 'DELETE', await f.reset());
  expect(await f.rows()).toEqual(inviter);
  kit.clock.advanceMs(60_000);
  accepted(kit, 'POST', await f.mark('jump_tip', { platform: 'taobao' }));
  const reread = states(kit, await f.get());
  expect(Object.keys(reread.jump_tip)).toEqual(['taobao']);
  at(reread.jump_tip['taobao'], kit.clock.now().toISOString());
  at(reread.inviter_before_buy);
});

it('[AC-B1-02s#11] 无记录 DELETE 仍成功，GET 仍为未读', async () => {
  const f = await fixture(kit);
  accepted(kit, 'DELETE', await f.reset());
  accepted(kit, 'DELETE', await f.reset());
  expect(states(kit, await f.get())).toEqual({ jump_tip: {}, inviter_before_buy: null });
  expect(await f.rows()).toEqual([]);
});

for (const tip of ['inviter_before_buy', 'unknown_tip']) {
  it(`[AC-B1-02s#12] DELETE ${tip} 返回 20001，现有记录不受影响`, async () => {
    const f = await fixture(kit);
    // Seed known state directly, so an invalid DELETE is itself the first tested operation.
    await f.db
      .insertInto('user_tip_reads')
      .values([
        {
          app_id: f.appId,
          user_id: f.uid,
          tip_key: 'jump_tip',
          platform: 'taobao',
          read_at: kit.clock.now(),
        },
        {
          app_id: f.appId,
          user_id: f.uid,
          tip_key: 'inviter_before_buy',
          platform: '',
          read_at: kit.clock.now(),
        },
      ])
      .execute();
    const original = await f.rows();
    envelope(kit, 'DELETE', RESET, await f.reset(tip), 20001);
    expect(await f.rows()).toEqual(original);
  });
}

it('[AC-B1-02s#13] 同 app 其他用户、其他 app 的读写及删除互不影响', async () => {
  const owner = await fixture(kit);
  const sameApp = await fixture(kit, owner.appId);
  const otherApp = await fixture(kit);
  for (const f of [sameApp, otherApp]) {
    accepted(kit, 'POST', await f.mark('jump_tip', { platform: 'jd' }));
    accepted(kit, 'POST', await f.mark('inviter_before_buy'));
  }
  const sameBefore = await sameApp.rows();
  const otherBefore = await otherApp.rows();
  expect(states(kit, await owner.get())).toEqual({ jump_tip: {}, inviter_before_buy: null });
  kit.clock.advanceMs(60_000);
  accepted(kit, 'POST', await owner.mark('jump_tip', { platform: 'jd' }));
  accepted(kit, 'POST', await owner.mark('inviter_before_buy'));
  at(states(kit, await owner.get()).jump_tip['jd'], kit.clock.now().toISOString());
  expect(await sameApp.rows()).toEqual(sameBefore);
  expect(await otherApp.rows()).toEqual(otherBefore);
  accepted(kit, 'DELETE', await owner.reset());
  expect(states(kit, await owner.get()).jump_tip).toEqual({});
  for (const f of [sameApp, otherApp]) {
    const data = states(kit, await f.get());
    expect(Object.keys(data.jump_tip)).toEqual(['jd']);
    at(data.jump_tip['jd']);
    at(data.inviter_before_buy);
  }
  expect(await sameApp.rows()).toEqual(sameBefore);
  expect(await otherApp.rows()).toEqual(otherBefore);
});

const routes: readonly [Method, string, string, unknown][] = [
  ['GET', TIPS, TIPS, undefined],
  ['POST', `${TIPS}/jump_tip/read`, READ, { platform: 'taobao' }],
  ['POST', `${TIPS}/inviter_before_buy/read`, READ, undefined],
  ['DELETE', `${TIPS}/jump_tip`, RESET, undefined],
];
for (const [method, url, contract, body] of routes) {
  it(`[AC-B1-02s#14] 游客 ${method} ${url} 返回 10001 且不写表`, async () => {
    const f = await fixture(kit);
    envelope(
      kit,
      method,
      contract,
      await f.device.request(method, url, body, { guest: true }),
      10001,
    );
    expect(await f.rows()).toEqual([]);
  });
}

it('[AC-B1-02s#15] 低版本 GET 不拦，两个 POST 和 DELETE 均由真实守卫返回 10405 且不写表', async () => {
  const f = await fixture(kit);
  await f.db
    .insertInto('user_tip_reads')
    .values({
      app_id: f.appId,
      user_id: f.uid,
      tip_key: 'jump_tip',
      platform: 'taobao',
      read_at: kit.clock.now(),
    })
    .execute();
  const original = await f.rows();
  const options = { headers: { 'x-app-version': '1.0.0' } };
  const data = states(kit, await f.device.request('GET', TIPS, undefined, options));
  expect(Object.keys(data.jump_tip)).toEqual(['taobao']);
  at(data.jump_tip['taobao']);
  for (const [method, url, contract, body] of routes.filter(([method]) => method !== 'GET')) {
    expect(
      envelope(kit, method, contract, await f.device.request(method, url, body, options), 10405),
    ).toEqual({ min_supported_version: '2.0.0' });
  }
  expect(await f.rows()).toEqual(original);
  // Boundary version is admitted by both write routes.
  accepted(kit, 'POST', await f.mark('jump_tip', { platform: 'jd' }));
  accepted(kit, 'DELETE', await f.reset());
  expect(await f.rows()).toEqual([]);
});

it('[AC-B1-02s#16] 同账号并发首次标记只有一行，后续并发重试保留首次时间', async () => {
  const f = await fixture(kit);
  const other = await client(kit, f.appId, f.uid);
  for (const [tip, body] of [
    ['jump_tip', { platform: 'taobao' }],
    ['inviter_before_buy', undefined],
  ] as const) {
    const responses = await Promise.all([
      f.mark(tip, body),
      other.request('POST', `${TIPS}/${tip}/read`, body),
    ]);
    for (const response of responses) accepted(kit, 'POST', response);
  }
  const original = await f.rows();
  expect(original).toHaveLength(2);
  expect(original.map((row) => [row.tip_key, row.platform, row.read_at.toISOString()])).toEqual([
    ['inviter_before_buy', '', NOW],
    ['jump_tip', 'taobao', NOW],
  ]);
  kit.clock.advanceMs(60_000);
  const responses = await Promise.all([
    f.mark('jump_tip', { platform: 'taobao' }),
    other.request('POST', `${TIPS}/jump_tip/read`, { platform: 'taobao' }),
    f.mark('inviter_before_buy'),
    other.request('POST', `${TIPS}/inviter_before_buy/read`),
  ]);
  for (const response of responses) accepted(kit, 'POST', response);
  expect(await f.rows()).toEqual(original);
});
