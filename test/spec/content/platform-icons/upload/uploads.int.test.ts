import { expect, it, vi } from 'vitest';
import { useHarness } from '../../../admin/auth/kit.ts';
import { seedConfig, changeConfig } from '../../read/kit.ts';
import { BODY_LIMIT, filePart, multipart } from '../../../platform/multipart/http-kit.ts';
import { withDimensions } from '../sanitize/png-fixtures.ts';
import {
  BASE,
  SVG,
  UNSAFE_SVG,
  digest,
  png,
  rejected,
  setup,
  snapshot,
  success,
  upload,
} from './kit.ts';

const h = useHarness();

it.each(['svg', 'png'] as const)(
  '[AC-F1-06x#1] %s 按清洗后内容存媒体与暂存，Clock + 24 小时；不建版本、不写审计',
  async (format) => {
    const f = await setup(h);
    const input = format === 'svg' ? UNSAFE_SVG : png();
    f.clock.advanceMs(1234);
    const before = await snapshot(h, f.appId);
    const result = await success(await upload(f, input), 'uploads');
    expect(result).toMatchObject({ format, sanitized: format === 'svg' });
    const stored = f.media.get(result.sha256);
    expect(stored).toBeDefined();
    expect(result.sha256).toBe(digest(stored!));
    expect(result.bytes).toBe(stored!.byteLength);
    expect(result.url).toBe(`${BASE.replace(/\/+$/, '')}/${result.sha256}.${format}`);
    expect(new Date(result.expires_at).getTime()).toBe(f.clock.now().getTime() + 86_400_000);
    if (format === 'svg') {
      expect(Buffer.from(stored!).toString()).not.toMatch(/script|onload|alert/i);
      expect(Buffer.from(stored!).toString()).toContain('<path');
      expect(result.sha256).not.toBe(digest(input));
    } else {
      expect(Buffer.from(stored!)).toEqual(input);
      expect(result.sha256).toBe(digest(input));
    }
    const after = await snapshot(h, f.appId);
    expect(after.uploads).toHaveLength(1);
    expect(after.uploads[0]).toEqual({
      id: result.upload_id,
      app_id: f.appId,
      key: 'jd',
      sha256: result.sha256,
      format,
      bytes: result.bytes,
      sanitized: result.sanitized,
      created_by_admin_id: f.actor.id,
      created_at: f.clock.now(),
      expires_at: new Date(f.clock.now().getTime() + 86_400_000),
    });
    expect(after.versions).toEqual(before.versions);
    expect(after.icons).toEqual(before.icons);
    expect(after.audits).toEqual(before.audits);
  },
);

it('[AC-F1-06x#2] 相同文件重传生成不同暂存编号，媒体摘要、URL 和内容保持相同', async () => {
  const f = await setup(h);
  const a = await success(await upload(f), 'uploads');
  const original = f.media.get(a.sha256);
  const b = await success(await upload(f), 'uploads');
  expect(b.upload_id).not.toBe(a.upload_id);
  expect(b).toMatchObject({ sha256: a.sha256, url: a.url, bytes: a.bytes });
  expect(f.media.get(a.sha256)).toEqual(original);
  expect((await snapshot(h, f.appId)).uploads).toHaveLength(2);
});

it.each([false, true])(
  '[AC-F1-06x#3] 媒体 put 前暂存行已提交到另一连接可见（put 失败=%s）',
  async (fail) => {
    const f = await setup(h);
    const before = await snapshot(h, f.appId);
    const put = f.media.put.bind(f.media);
    let rowsAtPut: Awaited<ReturnType<typeof snapshot>>['uploads'] = [];
    const spy = vi.spyOn(f.media, 'put').mockImplementation(async (input) => {
      // h.db is a pool handle, not the HTTP transaction: an uncommitted INSERT is invisible.
      rowsAtPut = (await snapshot(h, f.appId)).uploads;
      if (fail) throw new Error('injected media outage');
      return put(input);
    });
    try {
      const response = await upload(f);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(rowsAtPut).toHaveLength(1);
      expect(rowsAtPut[0]).toMatchObject({
        app_id: f.appId,
        key: 'jd',
        sha256: spy.mock.calls[0]![0].sha256,
        bytes: spy.mock.calls[0]![0].bytes.byteLength,
      });
      expect(spy.mock.calls[0]![0].contentType).toBe('image/svg+xml');
      if (fail) {
        await rejected(response, 'uploads', 50001);
        expect(JSON.stringify(response.json())).not.toContain('upload_id');
        expect(JSON.stringify(response.json())).not.toContain(rowsAtPut[0]!.id);
      } else {
        expect((await success(response, 'uploads')).upload_id).toBe(rowsAtPut[0]!.id);
      }
      const after = await snapshot(h, f.appId);
      expect(after.uploads).toEqual(rowsAtPut);
      expect(after.audits).toEqual(before.audits);
      expect(after.versions).toEqual(before.versions);
    } finally {
      spy.mockRestore();
    }
  },
);

it.each([
  ['非图像', () => Buffer.from('GIF89a'), 'icon_format_invalid'],
  ['损坏 SVG', () => Buffer.from('<svg'), 'icon_format_invalid'],
  ['PNG 过小', () => png(511, 512), 'icon_format_invalid'],
  ['PNG 过大', () => withDimensions(png(), 4097, 512), 'icon_format_invalid'],
  ['PNG 不透明', () => png(512, 512, 6, 0), 'icon_format_invalid'],
  ['默认上限', () => Buffer.concat([SVG, Buffer.alloc(204801 - SVG.length, 32)]), 'icon_too_large'],
  [
    '复杂选择器',
    () =>
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><style>path:hover{fill:red}</style><path d="M0 0h2v2z"/></svg>',
      ),
    'icon_svg_unconvertible',
  ],
] as const)(
  '[AC-F1-06x#4] %s 拒收 20001 [file] 和管理员 reason，无暂存与媒体副作用',
  async (_name, input, reason) => {
    const f = await setup(h);
    const before = await snapshot(h, f.appId);
    const put = vi.spyOn(f.media, 'put');
    try {
      await rejected(await upload(f, input()), 'uploads', 20001, { fields: ['file'], reason });
      expect(put).not.toHaveBeenCalled();
      expect(await snapshot(h, f.appId)).toEqual(before);
    } finally {
      put.mockRestore();
    }
  },
);

it('[AC-F1-06x#5] max_bytes 每次按 app 直接读库，等于上限可传、降低后立即拒收', async () => {
  const f = await setup(h);
  const input = png();
  const key = 'content.platform_icon.max_bytes';
  await seedConfig(h.db, f.appId, key, input.length, 1);
  await seedConfig(h.db, `${f.appId}-foreign`, key, 1, 1);
  const first = await success(await upload(f, input), 'uploads');
  expect(first.bytes).toBe(input.length);
  await changeConfig(h.db, f.appId, key, input.length - 1, 2);
  const before = await snapshot(h, f.appId);
  await rejected(await upload(f, input), 'uploads', 20001, {
    fields: ['file'],
    reason: 'icon_too_large',
  });
  expect(await snapshot(h, f.appId)).toEqual(before);
  await changeConfig(h.db, f.appId, key, input.length, 3);
  expect((await success(await upload(f, input), 'uploads')).sha256).toBe(first.sha256);
});

it.each(['empty', 'wrong-name', 'two-files', 'text-field', 'global-limit'] as const)(
  '[AC-F1-06x#6] multipart %s 沿用平台校验，超全局上限为 413 [body]',
  async (kind) => {
    const f = await setup(h);
    const before = await snapshot(h, f.appId);
    const body =
      kind === 'empty'
        ? multipart([])
        : kind === 'wrong-name'
          ? multipart([filePart(SVG, 'other')])
          : kind === 'two-files'
            ? multipart([filePart(SVG), filePart(SVG)])
            : kind === 'text-field'
              ? multipart([{ name: 'file', bytes: SVG }])
              : multipart([filePart(Buffer.alloc(BODY_LIMIT + 1))]);
    await rejected(
      await upload(f, SVG, 'jd', f.token, body),
      'uploads',
      20001,
      { fields: [kind === 'global-limit' ? 'body' : 'file'] },
      kind === 'global-limit' ? 413 : 400,
    );
    expect(await snapshot(h, f.appId)).toEqual(before);
  },
);
