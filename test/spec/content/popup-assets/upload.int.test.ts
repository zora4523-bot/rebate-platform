import { expect, it, vi } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { BODY_LIMIT } from '../../platform/multipart/http-kit.ts';
import { save, sections } from '../pages-admin/kit.ts';
import {
  digest,
  INVALID_IMAGES,
  INVALID_LOTTIE,
  JPEG,
  lottie,
  PNG,
  U_ONLY_LOTTIE,
} from './fixtures.ts';
import { MEDIA_BASE, rejected, setup, snapshot, success, upload } from './kit.ts';

const h = useHarness();

it('[AC-F1-09r#11] 180 KiB、2.4 秒的 Lottie 原样寻址；重传同址，上传不动已有页面，只审计摘要', async () => {
  const f = await setup(h);
  await save(f, 'home', 0, sections());
  const input = lottie({ nm: 'private-animation-marker' }, 180 * 1024);
  const sha256 = digest(input);
  const before = await snapshot(h, f.appId);
  f.clock.advanceMs(1234);
  const put = vi.spyOn(f.media, 'put');
  const get = vi.spyOn(f.media, 'get');
  try {
    const a = await success(await upload(f, input));
    expect(a).toEqual({
      url: `${MEDIA_BASE}${sha256}.json`,
      sha256,
      bytes: input.length,
      width: 750,
      height: 1000,
      duration_ms: 2400,
    });
    const b = await success(await upload(f, input, { fileFirst: true }));
    expect(b).toEqual(a);
    expect(put).toHaveBeenCalled();
    expect(new Set(put.mock.calls.map(([arg]) => arg.sha256))).toEqual(new Set([sha256]));
    for (const [arg] of put.mock.calls) {
      expect(arg).toMatchObject({ contentType: 'application/json', sha256 });
      expect(Buffer.from(arg.bytes)).toEqual(input);
    }
    expect(get).not.toHaveBeenCalled();
    expect(Buffer.from(f.media.get(sha256)!)).toEqual(input);
    const after = await snapshot(h, f.appId);
    expect(after.pages).toEqual(before.pages);
    expect(after.versions).toEqual(before.versions);
    const ids = new Set(before.audits.map((row) => row.id));
    const audits = after.audits.filter((row) => !ids.has(row.id));
    expect(audits).toHaveLength(2);
    for (const row of audits) {
      expect(row).toMatchObject({
        action: 'page_popup_asset_upload',
        app_id: f.appId,
        admin_id: f.actor.id,
        at: f.clock.now(),
      });
      expect(row.after).toEqual({ kind: 'lottie', sha256, bytes: input.length });
    }
    expect(
      JSON.stringify(audits, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toMatch(/private-animation-marker|private-popup|"layers"/);
    expect(f.lines.join('\n')).not.toMatch(/private-animation-marker|private-popup/);
  } finally {
    put.mockRestore();
    get.mockRestore();
  }
});

it.each(INVALID_LOTTIE)(
  '[AC-F1-09r#12] HTTP Lottie $name → 20001 [file] $reason，拒收无副作用',
  async ({ bytes, reason }) => {
    const f = await setup(h);
    const before = await snapshot(h, f.appId);
    const put = vi.spyOn(f.media, 'put');
    try {
      await rejected(await upload(f, bytes), 20001, { fields: ['file'], reason });
      expect(put).not.toHaveBeenCalled();
      expect(await snapshot(h, f.appId)).toEqual(before);
    } finally {
      put.mockRestore();
    }
  },
);

it.each([
  { name: '300 KiB 含边界', bytes: lottie({}, 307_200) },
  ...U_ONLY_LOTTIE,
  {
    name: '内嵌 data URI',
    bytes: lottie({ assets: [{ p: `data:image/png;base64,${PNG.toString('base64')}` }] }),
  },
])('[AC-F1-09r#13] HTTP 接收 $name', async ({ bytes }) => {
  const f = await setup(h);
  expect(await success(await upload(f, bytes))).toMatchObject({
    sha256: digest(bytes),
    bytes: bytes.length,
    duration_ms: 2400,
  });
});

it.each([
  { bytes: PNG, ext: 'png', contentType: 'image/png' },
  { bytes: JPEG, ext: 'jpg', contentType: 'image/jpeg' },
])(
  '[AC-F1-09r#14] $ext 按文件头判型，客户端声明 JSON 不影响上传及媒体类型',
  async ({ bytes, ext, contentType }) => {
    const f = await setup(h);
    const before = await snapshot(h, f.appId);
    const put = vi.spyOn(f.media, 'put');
    try {
      const result = await success(
        await upload(f, bytes, {
          kind: 'image',
          filename: 'picture.json',
          mimetype: 'application/json',
        }),
      );
      expect(result).toEqual({
        url: `${MEDIA_BASE}${digest(bytes)}.${ext}`,
        sha256: digest(bytes),
        bytes: bytes.length,
      });
      expect(put).toHaveBeenCalledWith({
        bytes: expect.any(Uint8Array),
        sha256: digest(bytes),
        contentType,
      });
      expect(Buffer.from(f.media.get(result.sha256)!)).toEqual(bytes);
      const after = await snapshot(h, f.appId);
      expect(after.pages).toEqual(before.pages);
      expect(after.versions).toEqual(before.versions);
      const audits = after.audits.filter((a) => !before.audits.some((b) => a.id === b.id));
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: 'page_popup_asset_upload',
        after: { kind: 'image', sha256: result.sha256, bytes: bytes.length },
      });
    } finally {
      put.mockRestore();
    }
  },
);

it.each(INVALID_IMAGES)(
  '[AC-F1-09r#15] HTTP 图片 $name 按 format 拒收，无媒体写入及审计',
  async ({ bytes }) => {
    const f = await setup(h);
    const before = await snapshot(h, f.appId);
    const put = vi.spyOn(f.media, 'put');
    try {
      await rejected(await upload(f, bytes, { kind: 'image' }), 20001, {
        fields: ['file'],
        reason: 'format',
      });
      expect(put).not.toHaveBeenCalled();
      expect(await snapshot(h, f.appId)).toEqual(before);
    } finally {
      put.mockRestore();
    }
  },
);

it('[AC-F1-09r#16] 超全局大小返回 413 [body]，不冒充文件 too_large', async () => {
  const f = await setup(h);
  const before = await snapshot(h, f.appId);
  const put = vi.spyOn(f.media, 'put');
  try {
    await rejected(
      await upload(f, Buffer.alloc(BODY_LIMIT + 1), { kind: 'image' }),
      20001,
      { fields: ['body'] },
      413,
    );
    expect(put).not.toHaveBeenCalled();
    expect(await snapshot(h, f.appId)).toEqual(before);
  } finally {
    put.mockRestore();
  }
});

it('[AC-F1-09r#17] 媒体 put 不可用返回 50001，不生成页面或成功审计', async () => {
  const f = await setup(h);
  const before = await snapshot(h, f.appId);
  const put = vi.spyOn(f.media, 'put').mockRejectedValue(new Error('synthetic media unavailable'));
  try {
    await rejected(await upload(f), 50001);
    expect(put).toHaveBeenCalledTimes(1);
    expect(await snapshot(h, f.appId)).toEqual(before);
  } finally {
    put.mockRestore();
  }
});

it('[AC-F1-09r#33] 500000 字节 PNG 超过 Lottie 限额但仍上传成功', async () => {
  const f = await setup(h);
  const bytes = Buffer.concat([PNG, Buffer.alloc(500_000 - PNG.length)]);
  const sha256 = digest(bytes);
  expect(await success(await upload(f, bytes, { kind: 'image', filename: 'popup.png' }))).toEqual({
    url: `${MEDIA_BASE}${sha256}.png`,
    sha256,
    bytes: 500_000,
  });
  expect(Buffer.from(f.media.get(sha256)!)).toEqual(bytes);
});

it('[AC-F1-09r#34] 1000001 字节 PNG 在全局请求上限内按文件 too_large 拒收', async () => {
  const f = await setup(h);
  const bytes = Buffer.concat([PNG, Buffer.alloc(1_000_001 - PNG.length)]);
  const before = await snapshot(h, f.appId);
  const put = vi.spyOn(f.media, 'put');
  try {
    await rejected(await upload(f, bytes, { kind: 'image', filename: 'popup.png' }), 20001, {
      fields: ['file'],
      reason: 'too_large',
    });
    expect(put).not.toHaveBeenCalled();
    expect(await snapshot(h, f.appId)).toEqual(before);
  } finally {
    put.mockRestore();
  }
});
