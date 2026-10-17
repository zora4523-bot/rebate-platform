// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { BridgeRequest, BridgeTransport } from '@couli/bridge-sdk';
import { afterEach, expect, it, vi } from 'vitest';
import { ArticleBody } from '../../../../apps/h5/src/components/article-body/index.ts';
import { CDN, doc, paragraph, text } from './fixtures.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(body: string) {
  return render(createElement(ArticleBody, { body, mediaCdnOrigin: CDN }));
}

function bridge(methods: BridgeTransport['methods'] = ['ext.openBrowser']) {
  const postMessage = vi.fn((request: BridgeRequest) => ({
    id: request.id,
    code: 0 as const,
    msg: '',
    data: {},
  }));
  const transport: BridgeTransport = {
    version: 1,
    methods,
    postMessage,
    subscribe: () => () => {},
  };
  vi.stubGlobal('__REBATE_BRIDGE__', transport);
  return postMessage;
}

it('[AC-F1-03a-BODY#1] doc、段落、三级标题和各个白名单节点按 HTML 语义呈现', () => {
  const view = mount(
    doc(
      paragraph('普通段落'),
      ...[1, 2, 3].map((level) => ({
        type: 'heading',
        attrs: { level },
        content: [text(`标题${level}`)],
      })),
      {
        type: 'paragraph',
        content: [
          { ...text('粗体'), marks: [{ type: 'bold' }] },
          { ...text('斜体'), marks: [{ type: 'italic' }] },
          { type: 'hardBreak' },
          text('换行后'),
        ],
      },
      ...['bulletList', 'orderedList'].map((type) => ({
        type,
        content: [
          { type: 'listItem', content: [paragraph(`${type}第一项`)] },
          { type: 'listItem', content: [paragraph(`${type}第二项`)] },
        ],
      })),
      { type: 'blockquote', content: [paragraph('引用内容')] },
      { type: 'horizontalRule' },
    ),
  );
  expect(screen.getByText('普通段落').tagName).toBe('P');
  for (const level of [1, 2, 3])
    expect(screen.getByRole('heading', { level, name: `标题${level}` }).tagName).toBe(`H${level}`);
  expect(screen.getByText('粗体').closest('strong')).not.toBeNull();
  expect(screen.getByText('斜体').closest('em')).not.toBeNull();
  expect(view.container.querySelectorAll('p > br')).toHaveLength(1);
  expect(view.container.querySelectorAll('ul > li')).toHaveLength(2);
  expect(view.container.querySelectorAll('ol > li')).toHaveLength(2);
  expect(view.container.querySelector('blockquote')?.textContent).toBe('引用内容');
  expect(view.container.querySelectorAll('hr')).toHaveLength(1);
});

for (const type of ['codeBlock', 'table', 'customWidget', 'html', 'script', 'iframe']) {
  it(`[AC-F1-03a-BODY#2] ${type} 整个未知子树丢弃，不渲染外壳或危险属性`, () => {
    const view = mount(
      doc(paragraph('保留文本'), {
        type,
        attrs: {
          html: '<img src=x onerror=alert(1)>',
          src: 'https://evil.invalid',
          onload: 'alert(1)',
        },
        content: [paragraph('未知子树文本')],
      }),
    );
    expect(view.container.textContent).toBe('保留文本');
    expect(
      view.container.querySelector('pre, code, table, script, iframe, img, customwidget'),
    ).toBeNull();
  });
}

it('[AC-F1-03a-BODY#3] 允许节点的 html、事件和样式属性不会进入 DOM，标记也受白名单约束', () => {
  const view = mount(
    doc({
      type: 'paragraph',
      attrs: {
        html: '<iframe src="https://evil.invalid"></iframe>',
        style: 'color:red',
        onclick: 'alert(1)',
      },
      content: [
        {
          ...text('<script>alert(1)</script><img src=x onerror=alert(1)>'),
          marks: [{ type: 'code' }, { type: 'strike' }, { type: 'customMark' }],
        },
      ],
    }),
  );
  expect(view.container.textContent).toBe('<script>alert(1)</script><img src=x onerror=alert(1)>');
  expect(
    view.container.querySelector('script, iframe, img, code, s, strike, [html], [onclick]'),
  ).toBeNull();
  expect(view.container.querySelector('p')?.getAttribute('style') ?? '').not.toContain('red');
});

it('[AC-F1-03a-BODY#4] 非白名单标题级别不输出 h4 至 h6', () => {
  const view = mount(
    doc(
      paragraph('保留文本'),
      ...[4, 5, 6].map((level) => ({
        type: 'heading',
        attrs: { level },
        content: [text(`非法级别${level}`)],
      })),
    ),
  );
  expect(view.container.textContent).toContain('保留文本');
  expect(view.container.querySelector('h4, h5, h6')).toBeNull();
});

for (const url of ['https://outside.example.invalid/help?q=rules']) {
  it(`[AC-F1-03a-LINK#1] ${url} 点击只调用 ext.openBrowser，阻止 WebView 默认跳转`, async () => {
    const postMessage = bridge();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const before = window.location.href;
    const view = mount(
      doc({
        type: 'paragraph',
        content: [{ ...text('外链说明'), marks: [{ type: 'link', attrs: { href: url } }] }],
      }),
    );
    const link = screen.getByRole('link', { name: '外链说明' });
    let prevented = false;
    view.container.addEventListener('click', (event) => {
      prevented = event.defaultPrevented;
    });
    // React's delegated handler is attached to the container before this listener.
    await userEvent.setup().click(link);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0]?.[0]).toMatchObject({
      method: 'ext.openBrowser',
      params: { url },
    });
    expect(prevented).toBe(true);
    expect(window.location.href).toBe(before);
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });
}

for (const href of [
  'http://example.com/help',
  'HTTP://example.com/help',
  '//evil.example/x',
  '/relative',
  'relative/path',
  'mailto:a@b',
  'tel:123456789',
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  ' javascript:alert(1)',
  '\tJaVaScRiPt:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  ' DaTa:text/html,<script>alert(1)</script>',
  'file:///etc/passwd',
]) {
  it(`[AC-F1-03a-LINK#2] ${href} 仅保留文本，不成为可点击链接`, async () => {
    const postMessage = bridge();
    const view = mount(
      doc({
        type: 'paragraph',
        content: [{ ...text('危险链接'), marks: [{ type: 'link', attrs: { href } }] }],
      }),
    );
    expect(screen.getByText('危险链接')).toBeTruthy();
    expect(view.container.querySelector('a, [role="link"]')).toBeNull();
    await userEvent.setup().click(screen.getByText('危险链接'));
    expect(postMessage).not.toHaveBeenCalled();
  });
}

for (const mode of ['absent', 'unsupported'] as const) {
  it(`[AC-F1-03a-LINK#3] bridge ${mode} 时 HTTPS 链接不直接跳转或打开新窗口`, async () => {
    const postMessage = bridge([]);
    if (mode === 'absent') vi.stubGlobal('__REBATE_BRIDGE__', undefined);
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const before = window.location.href;
    const view = mount(
      doc({
        type: 'paragraph',
        content: [
          {
            ...text('外链说明'),
            marks: [{ type: 'link', attrs: { href: 'https://outside.example.invalid/help' } }],
          },
        ],
      }),
    );
    const label = screen.getByText('外链说明');
    const anchor = label.closest('a[href]');
    let prevented = false;
    view.container.addEventListener('click', (event) => {
      prevented = event.defaultPrevented;
    });
    await userEvent.setup().click(label);
    // A plain-text fallback is allowed; a retained anchor must cancel native navigation.
    if (anchor !== null) expect(prevented).toBe(true);
    expect(window.location.href).toBe(before);
    expect(open).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });
}

it('[AC-F1-03a-IMAGE#1] 图片精确匹配配置的 CDN origin（协议、主机、端口），阻止伪装地址', () => {
  const allowed = `${CDN}/rules/guide.png`;
  const view = mount(
    doc(
      paragraph('图片正文'),
      ...[
        allowed,
        'https://other.invalid/image.png',
        `${CDN}.evil.invalid/image.png`,
        `${CDN}@evil.invalid/image.png`,
        'https://sub.media.example.invalid/image.png',
        'http://media.example.invalid/image.png',
        'https://media.example.invalid:8443/image.png',
        'data:image/svg+xml,<svg onload="alert(1)"/>',
        'javascript:alert(1)',
        'https://evil.invalid/image.png?next=https://media.example.invalid',
      ].map((src) => ({ type: 'image', attrs: { src, alt: '规则示意图', onerror: 'alert(1)' } })),
    ),
  );
  const images = view.container.querySelectorAll('img');
  expect(images).toHaveLength(1);
  expect(images[0]?.getAttribute('src')).toBe(allowed);
  expect(images[0]?.getAttribute('alt')).toBe('规则示意图');
  expect(images[0]?.hasAttribute('onerror')).toBe(false);
});

it('[AC-F1-03a-IMAGE#2] CDN 配置变更后不沿用测试域或旧域', () => {
  const view = render(
    createElement(ArticleBody, {
      mediaCdnOrigin: 'https://alternate-media.invalid',
      body: doc(
        ...[`${CDN}/old.png`, 'https://alternate-media.invalid/new.png'].map((src) => ({
          type: 'image',
          attrs: { src },
        })),
      ),
    }),
  );
  expect(
    Array.from(view.container.querySelectorAll('img'), (img) => img.getAttribute('src')),
  ).toEqual(['https://alternate-media.invalid/new.png']);
});

it('[AC-F1-03a-IMAGE#3] CDN 配置为空时不放行任意远程图片', () => {
  const view = render(
    createElement(ArticleBody, {
      body: doc(paragraph('安全文本'), { type: 'image', attrs: { src: `${CDN}/image.png` } }),
      mediaCdnOrigin: '',
    }),
  );
  expect(view.container.textContent).toBe('安全文本');
  expect(view.container.querySelector('img')).toBeNull();
});

it('[AC-F1-03a-IMAGE#4] 未传 CDN 配置时不放行任何远程图片', () => {
  const view = render(
    createElement(ArticleBody, {
      body: doc(
        paragraph('安全文本'),
        ...[`${CDN}/image.png`, 'https://other.invalid/image.png'].map((src) => ({
          type: 'image',
          attrs: { src },
        })),
      ),
    }),
  );
  expect(view.container.textContent).toBe('安全文本');
  expect(view.container.querySelector('img')).toBeNull();
});

for (const body of [
  '{broken JSON',
  'null',
  '[]',
  '"text"',
  '{}',
  '{"content":[]}',
  '{"type":"paragraph","content":[]}',
  '{"type":"doc","content":"x"}',
]) {
  it(`[AC-F1-03a-BODY#5] 非法文档 ${body} 在正文区显示错误，不向外抛异常`, () => {
    expect(() => mount(body)).not.toThrow();
    expect(screen.getByRole('alert').textContent).toMatch(/失败|出错|无法/);
  });
}
