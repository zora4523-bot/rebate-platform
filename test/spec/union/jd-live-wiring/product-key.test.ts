import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { UnionAdapter } from '../../../../apps/api/src/modules/union/domain/types.ts';
import { JdUnionAdapter } from '../../../../apps/api/src/modules/union/infra/jd/jd-adapter.ts';
import { inner, reply, row, win } from '../jd-orders/kit.ts';
import {
  SECRET,
  configured,
  context,
  endpoints,
  removeDirectory,
  startUnion,
  temporaryDirectory,
  visible,
  type UnionModuleOptions,
} from './kit.ts';

// BR-PROD-03: the module hands the live adapter the app's product_key.jd.mode through the same
// configuration port as the Taobao price settings (forRoot's `config`; union never imports content).
const MODE_KEY = 'product_key.jd.mode';
const ITEM_KEY = 'synthAseg-Bseg';
const SKU_KEY = '100012345678';
const OTHER_APP = 'fake-jd-wiring-other-app';
/** Stands in for the entry's database handle; the fake config factory never queries it. */
const database = Object.freeze({ synthetic: 'jd-product-key-db-handle' });

let directory: string;
beforeEach(async () => {
  directory = await temporaryDirectory();
  // One order row with both keys, so that the mapped item_id shows the mode the adapter used.
  const body = reply(inner([row({ itemId: ITEM_KEY })], false)).body;
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockImplementation(async () => new Response(body, { status: 200 })),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await removeDirectory(directory);
});

function reading(answer: (appId: string) => unknown) {
  return vi.fn<(appId: string, key: string) => Promise<unknown>>(async (appId) => answer(appId));
}

/** The live jd adapter of the real module factory. */
async function liveAdapter(
  options: UnionModuleOptions | undefined,
  db: unknown,
): Promise<UnionAdapter> {
  const file = join(directory, 'FAKE_JD_SECRET_FILE.txt');
  await writeFile(file, SECRET, 'utf8');
  const registry = await startUnion(configured(file), endpoints(), [], db, options);
  const adapter = registry.get('jd');
  expect(adapter).toBeInstanceOf(JdUnionAdapter);
  return adapter;
}

async function itemId(adapter: UnionAdapter, appId = context.appId): Promise<unknown> {
  const page = await adapter.listOrders(win, {}, { ...context, appId });
  expect(page.items).toHaveLength(1);
  return page.items[0]!.item_id;
}

it.each([
  ['sku', SKU_KEY],
  ['item', ITEM_KEY],
] as const)('[AC-B1-04ze#29] 配置 %s：商品键按它取，读 ctx.appId 的配置', async (mode, key) => {
  const read = reading(() => ({ value: mode, version: 1 }));
  const adapter = await liveAdapter({ config: () => ({ configValue: read }) }, database);
  await expect(itemId(adapter)).resolves.toBe(key);
  expect(read).toHaveBeenCalledExactlyOnceWith(context.appId, MODE_KEY);
});

it('[AC-B1-04ze#30] 每次 listOrders 按当次 app 读一次，不缓存：配置改了下一次就变', async () => {
  const modes = new Map([
    [context.appId, 'item'],
    [OTHER_APP, 'sku'],
  ]);
  const read = reading((appId) => ({ value: modes.get(appId), version: 1 }));
  const adapter = await liveAdapter({ config: () => ({ configValue: read }) }, database);
  await expect(itemId(adapter)).resolves.toBe(ITEM_KEY);
  await expect(itemId(adapter, OTHER_APP)).resolves.toBe(SKU_KEY);
  modes.set(context.appId, 'sku');
  await expect(itemId(adapter)).resolves.toBe(SKU_KEY);
  expect(read.mock.calls).toEqual([
    [context.appId, MODE_KEY],
    [OTHER_APP, MODE_KEY],
    [context.appId, MODE_KEY],
  ]);
});

it.each([null, undefined, { value: null, version: 1 }])(
  '[AC-B1-04ze#31] 配置未设（读到 %j）时缺省 item',
  async (answer) => {
    const read = reading(() => answer);
    const adapter = await liveAdapter({ config: () => ({ configValue: read }) }, database);
    await expect(itemId(adapter)).resolves.toBe(ITEM_KEY);
    expect(read).toHaveBeenCalledTimes(1);
  },
);

it('[AC-B1-04ze#32] 没有配置来源（forRoot 无 config，或有 config 而无数据库）时缺省 item', async () => {
  await expect(itemId(await liveAdapter(undefined, undefined))).resolves.toBe(ITEM_KEY);
  const read = reading(() => ({ value: 'sku', version: 1 }));
  const withoutDb = await liveAdapter({ config: () => ({ configValue: read }) }, undefined);
  await expect(itemId(withoutDb)).resolves.toBe(ITEM_KEY);
  expect(read).not.toHaveBeenCalled();
});

it.each(['FAKE_MODE_TEXT', 'SKU', '', 5, true])(
  '[AC-B1-04ze#33] 配置是其他值（%j）走现行失败方式 invalid_dto，不发请求、错误不带配置值',
  async (value) => {
    const read = reading(() => ({ value, version: 1 }));
    const adapter = await liveAdapter({ config: () => ({ configValue: read }) }, database);
    const error: unknown = await adapter
      .listOrders(win, {}, context)
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'invalid_dto', platform: 'jd' });
    expect(visible(error)).not.toContain('FAKE_MODE_TEXT');
    expect(fetch).not.toHaveBeenCalled();
  },
);
