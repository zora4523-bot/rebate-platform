import { sql } from 'kysely';
import { expect, it, vi } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  fields,
  publish,
  save,
  sections,
  seedDraft,
  send,
  setup,
  snapshot,
  success,
  type Setup,
} from './kit.ts';

// 只替换未有真实资料的静态规则表，使用合成域名 / 频道；保存、发布、Clock、DB、守卫皆真实。
vi.mock('../../../../apps/api/src/modules/platform/specs/link-patterns.ts', () => ({
  getLinkPatterns: () => ({
    version: 'synthetic',
    rules: [
      { platform: 'taobao', category: 'union_host', hosts: ['union-a.test'], path_patterns: [] },
      { platform: 'jd', category: 'promo', hosts: ['promo.test'], path_patterns: ['/**'] },
    ],
  }),
}));
vi.mock('../../../../apps/api/src/modules/platform/specs/material-channels.ts', () => ({
  getMaterialChannels: () => ({
    version: 'synthetic',
    channels: [
      {
        platform: 'taobao',
        channel_id: 'sales_a',
        name: '合成可选频道',
        sort_basis: 'sales',
        selectable: true,
        source: 'synthetic',
      },
      {
        platform: 'jd',
        channel_id: 'sales_a',
        name: '合成不可选频道',
        sort_basis: 'sales',
        selectable: false,
        source: 'synthetic',
      },
    ],
  }),
}));

const h = useHarness();
const ACTION = 'sections.0.data_source.items.0.action';
const URL_PATH = `${ACTION}.params.url`;
const external = (url: string) => sections('external', { route: 'ExternalPage', params: { url } });

async function blockValue(f: Setup, value: unknown) {
  await h.db
    .insertInto('config_items')
    .values({
      app_id: f.appId,
      key: 'external_page.union_host_block',
      value: sql`${JSON.stringify(value)}::jsonb`,
      version: 1,
      row_version: 1,
      updated_by: f.actor.username,
      created_at: f.clock.now(),
      updated_at: f.clock.now(),
    })
    .onConflict((oc) =>
      oc.columns(['app_id', 'key']).doUpdateSet({ value: sql`${JSON.stringify(value)}::jsonb` }),
    )
    .execute();
}

it.each(['save', 'publish'] as const)(
  '[AC-F1-09f#24] %s 开关缺省按开启拦联盟域，false 即刻放行，重新打开即刻拦截',
  async (op) => {
    const f = await setup(h);
    const value = external('https://m.UNION-A.TEST.:8443/promo');
    if (op === 'publish') await seedDraft(h, f, 'home', value);
    const body =
      op === 'save'
        ? { sections: value, expected_revision: 0 }
        : { version: 1, gray_percent: 100, expected_revision: 1 };
    const before = await snapshot(h, f.appId);
    await fields(await send(f, op, 'home', body), [URL_PATH]);
    expect(await snapshot(h, f.appId)).toEqual(before);
    await blockValue(f, false);
    f.clock.advanceMs(1000);
    await success(await send(f, op, 'home', body));
    const key = 'custom:after_on';
    if (op === 'publish') await seedDraft(h, f, key, value);
    await blockValue(f, true);
    // 少于 60 秒仍须读取事务内的真实值，不能复用 false 的缓存。
    f.clock.advanceMs(1000);
    const after = await snapshot(h, f.appId);
    await fields(await send(f, op, key, body), [URL_PATH]);
    expect(await snapshot(h, f.appId)).toEqual(after);
  },
);

it('[AC-F1-09f#25] 保存时开关关闭、发布前打开，原本合法草稿也重新校验且仍保持 draft', async () => {
  const f = await setup(h);
  await blockValue(f, false);
  await save(f, 'home', 0, external('https://union-a.test/a'));
  await blockValue(f, true);
  const before = await snapshot(h, f.appId);
  f.clock.advanceMs(1000);
  await fields(
    await send(f, 'publish', 'home', { version: 1, gray_percent: 100, expected_revision: 1 }),
    [URL_PATH],
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
});

it.each([null, 0, 'false'])(
  '[AC-F1-09f#26] 开关值 %j 不是布尔 false，仍然拦截联盟域',
  async (value) => {
    const f = await setup(h);
    await blockValue(f, value);
    const before = await snapshot(h, f.appId);
    await fields(
      await send(f, 'save', 'home', {
        sections: external('https://union-a.test/'),
        expected_revision: 0,
      }),
      [URL_PATH],
    );
    expect(await snapshot(h, f.appId)).toEqual(before);
  },
);

const INVALID = [
  ...['Withdraw', 'PayoutAccount', 'LaborAgreement', 'RealName'].map((route) => ({
    name: `${route} 带参数`,
    value: sections('funds', { route, params: { from: 'home' } }),
    required: [`${ACTION}.params`],
    exact: true,
  })),
  {
    name: '外链个人数据占位',
    value: external('https://brand.test/?id=%7Buid%7D'),
    required: [URL_PATH],
    exact: true,
  },
  {
    name: '未知跳转名称',
    value: sections('unknown_route', { route: 'MissingSyntheticRoute' }),
    required: [`${ACTION}.route`],
    exact: true,
  },
  {
    name: '非公告 API 数据源',
    value: [
      {
        id: 'notice',
        type: 'notice_bar',
        version: 1,
        data_source: { kind: 'api', path: '/v1/users' },
      },
    ],
    required: ['sections.0.data_source'],
    exact: false,
  },
  {
    name: '频道不可选',
    value: [
      {
        id: 'feed',
        type: 'feed_infinite',
        version: 1,
        data_source: {
          kind: 'union_material',
          channels: [{ platform: 'jd', channel_id: 'sales_a' }],
        },
      },
    ],
    required: ['sections.0.data_source'],
    exact: true,
  },
  {
    name: '频道不在表内',
    value: [
      {
        id: 'feed',
        type: 'feed_infinite',
        version: 1,
        data_source: {
          kind: 'union_material',
          channels: [{ platform: 'taobao', channel_id: 'missing' }],
        },
      },
    ],
    required: ['sections.0.data_source'],
    exact: true,
  },
  {
    name: 'section id 形状',
    value: [{ ...sections()[0], id: 'bad.id' }],
    required: ['sections.0.id'],
    exact: false,
  },
  {
    name: 'section 缺 id',
    value: [{ type: 'banner', version: 1, data_source: { kind: 'static', items: [] } }],
    required: ['sections.0.id'],
    exact: false,
  },
  {
    name: 'section type 类型',
    value: [{ id: 'bad_type', type: 42, version: 1 }],
    required: ['sections.0.type'],
    exact: false,
  },
  {
    name: 'section version 非正数',
    value: [{ ...sections()[0], version: 0 }],
    required: ['sections.0.version'],
    exact: false,
  },
  {
    name: 'props 形状',
    value: [{ ...sections()[0], props: { autoplay_ms: -1 } }],
    required: ['sections.0.props.autoplay_ms'],
    exact: false,
  },
  {
    name: '多 popup',
    value: ['one', 'two'].map((id) => ({ ...sections(id)[0], type: 'popup' })),
    required: ['sections'],
    exact: false,
  },
  {
    name: '重复 section id',
    value: [...sections('duplicate'), ...sections('duplicate')],
    required: [],
    exact: false,
  },
  {
    name: 'union_material 禁止 platforms',
    value: [
      {
        id: 'feed',
        type: 'feed_infinite',
        version: 1,
        data_source: { kind: 'union_material', platforms: ['taobao'] },
      },
    ],
    required: ['sections.0.data_source'],
    exact: false,
  },
];

it.each(INVALID.flatMap((value) => (['save', 'publish'] as const).map((op) => ({ ...value, op }))))(
  '[AC-F1-09f#27] $op 拒绝 $name，fields 点号去重且拒绝后数据审计不变',
  async ({ op, value, required, exact }) => {
    const f = await setup(h);
    if (op === 'publish') await seedDraft(h, f, 'home', value);
    const before = await snapshot(h, f.appId);
    const body =
      op === 'save'
        ? { sections: value, expected_revision: 0 }
        : { version: 1, gray_percent: 100, expected_revision: 1 };
    await fields(await send(f, op, 'home', body), required, exact);
    expect(await snapshot(h, f.appId)).toEqual(before);
  },
);

it.each(['save', 'publish'] as const)(
  '[AC-F1-09f#28] %s 合并形状与业务校验错误，同一路径只返回一次',
  async (op) => {
    const f = await setup(h);
    const value = [{ ...sections('bad.id', { route: 'Withdraw', params: 42 })[0] }];
    if (op === 'publish') await seedDraft(h, f, 'home', value);
    const before = await snapshot(h, f.appId);
    const body =
      op === 'save'
        ? { sections: value, expected_revision: 0 }
        : { version: 1, gray_percent: 100, expected_revision: 1 };
    await fields(await send(f, op, 'home', body), ['sections.0.id', `${ACTION}.params`], false);
    expect(await snapshot(h, f.appId)).toEqual(before);
  },
);

it('[AC-F1-09f#29] 正向：空页、普通外链、公告 CMS、可选频道及无参资金路由均可保存并发布', async () => {
  const f = await setup(h);
  const values = [
    [],
    external('https://brand.test/promo'),
    external('https://promo.test/path'),
    [{ id: 'notice', type: 'notice_bar', version: 1, data_source: { kind: 'api' } }],
    [
      {
        id: 'feed',
        type: 'feed_infinite',
        version: 1,
        data_source: {
          kind: 'union_material',
          channels: [{ platform: 'taobao', channel_id: 'sales_a' }],
        },
      },
    ],
    sections('withdraw', { route: 'Withdraw' }),
  ];
  for (const [index, value] of values.entries()) {
    const key = `custom:valid_${index}`;
    const saved = await save(f, key, 0, value);
    expect(saved.sections).toEqual(value);
    expect(await publish(f, key, 1, 1)).toMatchObject({ current_version: 1, revision: 2 });
  }
});

it('[AC-F1-09f#30] 灰度发布也重新校验，不只在首次全量发布校验', async () => {
  const f = await setup(h);
  await save(f, 'home', 0);
  await publish(f, 'home', 1, 1);
  await blockValue(f, false);
  expect(await save(f, 'home', 2, external('https://union-a.test/'))).toMatchObject({ version: 2 });
  await blockValue(f, true);
  const before = await snapshot(h, f.appId);
  await fields(
    await send(f, 'publish', 'home', { version: 2, gray_percent: 10, expected_revision: 3 }),
    [URL_PATH],
  );
  expect(await snapshot(h, f.appId)).toEqual(before);
});
