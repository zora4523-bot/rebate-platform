// B1-27h（brief §9 ②; D10-138）：副本复用 platform/export-store，扩出副本自己的对象键与内容类型。每次运行
// 一个独立对象键（同一副本两次运行的键不同），键带 app_id 与副本 id、以 .zip 结尾、永远不是导出的
// `<app_id>/<export_id>.csv` 形状；副本键只收 application/zip（或封存件的 application/octet-stream），
// 导出键仍只收 text/csv；签名链接、校验与删除照导出键。staging / prod 在 OSS 适配器（B1-30）前照常
// 按请求失败（ExportStoreUnavailableError）。不连库。
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createExportStore,
  dataCopyObjectKey,
  ExportStoreUnavailableError,
  MemoryExportStore,
  type ExportPutInput,
} from '../../../../apps/api/src/modules/platform/export-store/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import { EXPORT_KEY_SHAPE, MINUTE_MS, NOW } from './kit.ts';

const APP = 'brand_a';
const COPY = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5d01';
const OTHER_COPY = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5d02';
const ZIP = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)]);

function memory() {
  const clock = new FixedClock(NOW);
  const logger = createRootLogger({ level: 'silent', entry: 'worker', appEnv: 'test' });
  const store = new MemoryExportStore({
    baseUrl: 'https://exports.example.invalid',
    signingKey: 'synthetic-data-copy-store-key',
    clock,
    logger,
  });
  return { clock, logger, store };
}

it('[AC-B1-27h#5] dataCopyObjectKey：带 app_id 与副本 id、以 .zip 结尾、不是导出键形状；每次运行一个键（同输入同键，换运行、换副本、换 app 都换键）；put / get / 签名链接 / 校验 / 删除照常', async () => {
  const { clock, store } = memory();
  const key = dataCopyObjectKey(APP, COPY, 'run1');
  expect(key.split('/')).toContain(APP);
  expect(key).toContain(COPY);
  expect(key.endsWith('.zip')).toBe(true);
  expect(EXPORT_KEY_SHAPE.test(key)).toBe(false);
  expect(dataCopyObjectKey(APP, COPY, 'run1')).toBe(key);
  const others = [
    dataCopyObjectKey(APP, COPY, 'run2'),
    dataCopyObjectKey(APP, OTHER_COPY, 'run1'),
    dataCopyObjectKey('brand_b', COPY, 'run1'),
  ];
  expect(new Set([key, ...others]).size).toBe(4);

  await store.put({ key, bytes: ZIP, contentType: 'application/zip' });
  expect(store.get(key)).toEqual({ bytes: ZIP, contentType: 'application/zip' });
  const expiresAt = new Date(clock.now().getTime() + 5 * MINUTE_MS);
  const link = await store.signedUrl({ key, expiresAt });
  expect(link.expiresAt).toEqual(expiresAt);
  expect(store.verify(link.url, clock.now())).toBe(true);
  expect(store.verify(link.url, expiresAt)).toBe(false);
  await store.delete(key);
  expect(store.get(key)).toBeUndefined();
  await store.delete(key);
});

it('[AC-B1-27h#6] 副本键不收 text/csv，导出键不收 application/zip；改过的副本键与形状不对的组成部分一律拒绝，不碰已有文件', async () => {
  const { store } = memory();
  const key = dataCopyObjectKey(APP, COPY, 'run1');
  const exportKey = `${APP}/exp_1.csv`;
  await store.put({ key, bytes: ZIP, contentType: 'application/zip' });
  await store.put({ key: exportKey, bytes: ZIP, contentType: 'text/csv' });
  const refused: ExportPutInput[] = [
    { key, bytes: new Uint8Array(), contentType: 'text/csv' },
    { key: exportKey, bytes: new Uint8Array(), contentType: 'application/zip' },
    { key: `${key}/extra`, bytes: ZIP, contentType: 'application/zip' },
    { key: key.replace(/\.zip$/, '.csv'), bytes: ZIP, contentType: 'application/zip' },
    { key: `../${key}`, bytes: ZIP, contentType: 'application/zip' },
    { key: key.replace(APP, 'BRAND_A'), bytes: ZIP, contentType: 'application/zip' },
  ];
  for (const input of refused) {
    await expect(
      Promise.resolve().then(() => store.put(input)),
      `${input.key} ${input.contentType}`,
    ).rejects.toBeInstanceOf(Error);
  }
  expect(store.get(key)?.bytes).toEqual(ZIP);
  expect(store.get(exportKey)?.bytes).toEqual(ZIP);
  for (const [appId, copyId, run] of [
    ['', COPY, 'run1'],
    ['Brand', COPY, 'run1'],
    ['brand/a', COPY, 'run1'],
    [APP, '', 'run1'],
    [APP, '../x', 'run1'],
    [APP, 'a b', 'run1'],
    [APP, COPY, ''],
    [APP, COPY, '../run'],
    [APP, COPY, 'a/b'],
  ] as const) {
    expect(() => dataCopyObjectKey(appId, copyId, run), `${appId}|${copyId}|${run}`).toThrow();
  }
});

it('[AC-B1-27h#7] staging / prod（OSS 适配器 B1-30 之前）：副本 put 按请求失败 ExportStoreUnavailableError，删除照常成功', async () => {
  const { clock, logger } = memory();
  const key = dataCopyObjectKey(APP, COPY, 'run1');
  for (const appEnv of ['staging', 'prod'] as const) {
    const store = createExportStore({
      appEnv,
      baseUrl: undefined,
      signingKey: undefined,
      clock,
      logger,
    });
    await expect(
      store.put({ key, bytes: ZIP, contentType: 'application/zip' }),
    ).rejects.toBeInstanceOf(ExportStoreUnavailableError);
    await expect(store.delete(key)).resolves.toBeUndefined();
  }
});
