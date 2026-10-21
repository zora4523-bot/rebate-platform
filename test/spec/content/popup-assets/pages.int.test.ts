import { expect, it, vi } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { fields, publish, save, sections, seedDraft, send } from '../pages-admin/kit.ts';
import { lottie, PNG } from './fixtures.ts';
import { MEDIA_BASE, setup, snapshot, success, upload } from './kit.ts';

const h = useHarness();
const SHA = 'a'.repeat(64);

function popup(
  reference?: { url: string; sha256: string },
  image: string | undefined = 'https://pictures.test/fallback.png',
) {
  return [
    ...sections('banner_before_popup'),
    {
      id: 'popup_asset',
      type: 'popup',
      version: 1,
      data_source: { kind: 'static', items: [] },
      props: {
        ...(image === undefined ? {} : { image }),
        ...(reference === undefined ? {} : { lottie: reference }),
      },
    },
  ];
}

const INVALID_REFS = [
  { name: '外部域', url: `https://foreign.test/media/${SHA}.json` },
  { name: '域名前缀伪装', url: `https://media.popup.test.evil.test/media/${SHA}.json` },
  { name: 'userinfo 伪装', url: `https://media.popup.test@foreign.test/media/${SHA}.json` },
  { name: '遗漏 media 路径前缀', url: `https://media.popup.test/${SHA}.json` },
  { name: '摘要不匹配', url: `${MEDIA_BASE}${'b'.repeat(64)}.json` },
  { name: '图片伪装为动画', url: `${MEDIA_BASE}${SHA}.png` },
  { name: '拼接 query', url: `${MEDIA_BASE}${SHA}.json?other=1` },
  { name: '路径穿越', url: `${MEDIA_BASE}../${SHA}.json` },
];

it.each(
  INVALID_REFS.flatMap((item) => (['save', 'publish'] as const).map((op) => ({ ...item, op }))),
)(
  '[AC-F1-09r#20] $op 拒绝 $name，返回实际下标点路径、无 reason，页面和审计不变',
  async ({ op, url }) => {
    const f = await setup(h);
    const value = popup({ url, sha256: SHA });
    if (op === 'publish') await seedDraft(h, f, 'home', value);
    const before = await snapshot(h, f.appId);
    const get = vi.spyOn(f.media, 'get');
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('must not download popup'));
    try {
      await fields(
        await send(
          f,
          op,
          'home',
          op === 'save'
            ? { sections: value, expected_revision: 0 }
            : { version: 1, gray_percent: 100, expected_revision: 1 },
        ),
        ['sections.1.props.lottie'],
      );
      expect(await snapshot(h, f.appId)).toEqual(before);
      expect(get).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
      fetch.mockRestore();
    }
  },
);

it('[AC-F1-09r#21] 本次上传的动画和兜底图可保存发布，宽高比差异不拦截且不再读媒体', async () => {
  const f = await setup(h);
  const animation = await success(await upload(f, lottie()));
  const image = await success(await upload(f, PNG, { kind: 'image' }));
  // 750:1000 animation versus 1:1 image, deliberately more than 2% apart.
  const value = popup({ url: animation.url, sha256: animation.sha256 }, image.url);
  const put = vi.spyOn(f.media, 'put');
  const get = vi.spyOn(f.media, 'get');
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('must not download popup'));
  try {
    expect(await save(f, 'home', 0, value)).toMatchObject({ version: 1, sections: value });
    expect(await publish(f, 'home', 1, 1)).toMatchObject({ current_version: 1, revision: 2 });
    expect(put).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    put.mockRestore();
    get.mockRestore();
    fetch.mockRestore();
  }
});

it('[AC-F1-09r#22] 合法引用无需在本进程上传或查找文件，保存发布只核对地址', async () => {
  const f = await setup(h);
  const value = popup({ url: `${MEDIA_BASE}${SHA}.json`, sha256: SHA });
  const get = vi.spyOn(f.media, 'get');
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('must not download popup'));
  try {
    expect(await save(f, 'home', 0, value)).toMatchObject({ sections: value });
    expect(await publish(f, 'home', 1, 1)).toMatchObject({ current_version: 1 });
    expect(get).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    get.mockRestore();
    fetch.mockRestore();
  }
});

it('[AC-F1-09r#23] 未配置 lottie 的旧弹窗仍可保存发布', async () => {
  const f = await setup(h);
  const value = popup();
  expect(await save(f, 'home', 0, value)).toMatchObject({ sections: value });
  expect(await publish(f, 'home', 1, 1)).toMatchObject({ current_version: 1 });
});

it.each(['save', 'publish'] as const)(
  '[AC-F1-09r#24] %s 有 lottie 必须有兜底 image',
  async (op) => {
    const f = await setup(h);
    const value = popup({ url: `${MEDIA_BASE}${SHA}.json`, sha256: SHA });
    // Keep the reference valid so only the required fallback triggers shape validation.
    const missing = value.map((section) =>
      section.type === 'popup'
        ? { ...section, props: { lottie: { url: `${MEDIA_BASE}${SHA}.json`, sha256: SHA } } }
        : section,
    );
    if (op === 'publish') await seedDraft(h, f, 'home', missing);
    const before = await snapshot(h, f.appId);
    const sent = await send(
      f,
      op,
      'home',
      op === 'save'
        ? { sections: missing, expected_revision: 0 }
        : { version: 1, gray_percent: 100, expected_revision: 1 },
    );
    // dependentRequired is reported at props by the existing shape issue mapper.
    await fields(sent, ['sections.1.props']);
    expect(await snapshot(h, f.appId)).toEqual(before);
  },
);
