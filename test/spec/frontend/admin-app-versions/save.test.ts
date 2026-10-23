// @vitest-environment jsdom
import { cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LIST, PRIMARY, READY, TARGET, createServer, item, payload } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  assertNoStepUp,
  button,
  change,
  click,
  edit,
  editor,
  field,
  fill,
  listedVersion,
  mount,
  save,
  saved,
  settled,
  storeName,
  verify,
} from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each([
  { platform: 'ios', channel: 'appstore' },
  { platform: 'android', channel: 'huawei' },
  { platform: 'harmony', channel: 'agc' },
] as const)(
  '[AC-F1-10h-SAVE#6] $platform/$channel 单行读取和保存使用所选端渠道，row_version=0 不丢失',
  async (target) => {
    const original = item({ ...target, row_version: 0 });
    const server = createServer([original]);
    const path = `${LIST}/${target.platform}/${target.channel}`;
    await mount(server, { editor: true, target });
    await waitFor(() => expect(field('latest_version').value).toBe(original.latest_version));
    expect(server.requests('GET', path)).toHaveLength(1);
    expect(server.requests('GET', LIST)).toEqual([]);
    await change('update_title', '端渠道独立保存');
    await save();
    await waitFor(() => expect(server.requests('PUT', path)).toHaveLength(1));
    await settled(server);
    expect(server.requests('PUT')).toHaveLength(1);
    expect(server.requests('PUT', path)[0]!.body).toEqual(
      payload(original, { update_title: '端渠道独立保存' }),
    );
    assertNoStepUp(server);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10h-SAVE#1] 整行编辑版本、标题、说明、商店地址和默认商店，带读取到的 CAS 值',
  async () => {
    const { server } = await mount();
    await edit();
    expect(field('update_title').value).toBe(item().update_title);
    expect(field('update_notes').value).toBe(item().update_notes);
    await change('latest_version', '5.0.0');
    await change('recommended_version', '4.0.0');
    await change('update_title', '运营新标题');
    await change('update_notes', '第一条更新\n第二条更新');
    await change('store_url', 'https://stores.example.test/changed');
    await change('default_store', READY);
    await save();
    await saved(server);
    expect(server.requests('PUT', TARGET)[0]!.body).toEqual(
      payload(item(), {
        latest_version: '5.0.0',
        recommended_version: '4.0.0',
        update_title: '运营新标题',
        update_notes: '第一条更新\n第二条更新',
        store_url: 'https://stores.example.test/changed',
        default_store: READY,
      }),
    );
    assertNoStepUp(server);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10h-SAVE#2] 商店可新增、删除、改已上架版本并调整顺序，按屏幕顺序发送',
  async () => {
    const { server } = await mount();
    await edit();
    await click(button(editor(), /新增商店|添加商店/));
    let names = within(editor()).getAllByLabelText(storeName);
    await fill(names.at(-1)!, 'demo_added');
    await fill(within(editor()).getAllByLabelText(listedVersion).at(-1)!, '3.8.0');
    await click(button(editor(), /上移.*demo_added|demo_added.*上移/));
    // Original second store is removed; the added store precedes demo_ready after the move.
    await click(button(editor(), /(?:删除|移除).*demo_slow_a|demo_slow_a.*(?:删除|移除)/));
    names = within(editor()).getAllByLabelText(storeName);
    expect(names.map((node) => (node as HTMLInputElement).value)).toEqual([
      PRIMARY,
      'demo_slow_b',
      'demo_added',
      READY,
    ]);
    await fill(within(editor()).getAllByLabelText(listedVersion)[0]!, '4.13.0');
    await save();
    await saved(server);
    expect(server.requests('PUT', TARGET)[0]!.body).toEqual(
      payload(item(), {
        store_listings: [
          { store: PRIMARY, listed_version: '4.13.0' },
          { store: 'demo_slow_b', listed_version: '2.8.9' },
          { store: 'demo_added', listed_version: '3.8.0' },
          { store: READY, listed_version: '2.10.0' },
        ],
      }),
    );
    assertNoStepUp(server);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10h-SAVE#3] 不擅自限制三个版本的大小关系，推荐版本可以高于最新版本',
  async () => {
    const { server } = await mount();
    await edit();
    await change('recommended_version', '12.0.0');
    await change('latest_version', '1.0.0');
    await save();
    await saved(server);
    expect(server.requests('PUT', TARGET)[0]!.body).toEqual(
      payload(item(), {
        recommended_version: '12.0.0',
        latest_version: '1.0.0',
      }),
    );
    assertNoStepUp(server);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10h-SAVE#4] 清空可空字段保留 null 语义，包括商店未登记上架版本',
  async () => {
    const { server } = await mount();
    await edit();
    await change('min_supported_version', '');
    await change('recommended_version', '');
    await fill(within(editor()).getAllByLabelText(listedVersion)[1]!, '');
    await save();
    await saved(server);
    const listings = item().store_listings;
    listings[1]!.listed_version = null;
    expect(server.requests('PUT', TARGET)[0]!.body).toEqual(
      payload(item(), {
        min_supported_version: null,
        recommended_version: null,
        store_listings: listings,
      }),
    );
    assertNoStepUp(server);
  },
  FLOW_TIMEOUT,
);

it.each(['1.0.0', null])(
  '[AC-F1-10h-SAVE#5] 30701 创建整行发送 expected_row_version=null，最低版本=%s，仅设置非空最低版本先动态码',
  async (minimum) => {
    const server = createServer([]);
    await mount(server, { editor: true });
    await waitFor(() =>
      expect(document.body.textContent).toMatch(/未.*(?:登记|配置|创建)|不存在|新建/),
    );
    const create = within(document.body).queryByRole('button', { name: /新建|创建/ });
    if (create) await click(create);
    expect(server.requests('GET', TARGET)).toHaveLength(1);
    expect(server.requests('GET', LIST)).toEqual([]);
    await change('latest_version', '1.2.0');
    if (minimum !== null) await change('min_supported_version', minimum);
    else expect(field('min_supported_version').value).toBe('');
    await change('recommended_version', '1.1.0');
    await change('update_title', '首次登记');
    await change('update_notes', '首次更新说明');
    await change('store_url', 'https://stores.example.test/first');
    if (within(editor()).queryAllByLabelText(storeName).length === 0)
      await click(button(editor(), /新增商店|添加商店/));
    await fill(within(editor()).getAllByLabelText(storeName)[0]!, PRIMARY);
    await fill(within(editor()).getAllByLabelText(listedVersion)[0]!, '1.2.0');
    await change('default_store', PRIMARY);
    await save();
    if (minimum !== null) {
      expect(server.requests('PUT')).toEqual([]);
      await verify();
    }
    await saved(server);
    expect(server.requests('PUT', TARGET)[0]!.body).toEqual({
      latest_version: '1.2.0',
      min_supported_version: minimum,
      recommended_version: '1.1.0',
      update_title: '首次登记',
      update_notes: '首次更新说明',
      store_url: 'https://stores.example.test/first',
      default_store: PRIMARY,
      store_listings: [{ store: PRIMARY, listed_version: '1.2.0' }],
      confirmed_stores: [],
      expected_row_version: null,
    });
    if (minimum !== null)
      expect(server.requests('PUT', TARGET)[0]!.headers.get('X-Step-Up-Token')).toBe(
        'example-step-up',
      );
    else assertNoStepUp(server);
    expect(server.requests('PUT', TARGET)[0]!.headers.has('Idempotency-Key')).toBe(false);
  },
  FLOW_TIMEOUT,
);
