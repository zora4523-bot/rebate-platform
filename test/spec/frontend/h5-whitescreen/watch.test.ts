// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  startWhitescreenWatch,
  type WhitescreenReport,
} from '../../../../apps/h5/src/shared/whitescreen/index.ts';

beforeEach(() => {
  vi.useFakeTimers();
  window.history.replaceState(null, '', '/rules');
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  document.cookie = 'fixture_session=; Max-Age=0; Path=/';
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

function rootWith(html: string): HTMLElement {
  const root = document.createElement('main');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

function watch(root: HTMLElement, timeoutMs?: number) {
  const report = vi.fn<(event: WhitescreenReport) => void>();
  const cancel = startWhitescreenWatch({
    root,
    report,
    env: { platform: null, version: null },
    now: () => performance.now(),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { report, cancel };
}

it('[AC-F1-01e-WHITE#1] 首屏 2999ms 不报告，3000ms 检查空根且只报告一次', () => {
  const { report } = watch(rootWith(''));
  expect(report).not.toHaveBeenCalled();
  vi.advanceTimersByTime(2999);
  expect(report).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(report).toHaveBeenCalledExactlyOnceWith({
    kind: 'whitescreen',
    path: '/rules',
    platform: null,
    version: null,
    elapsed_ms: 3000,
  });
  vi.advanceTimersByTime(30_000);
  expect(report).toHaveBeenCalledTimes(1);
});

it.each([
  ['注释', '<!-- pending -->'],
  ['只有文本但没有元素子节点', 'pending'],
  ['空白嵌套元素', '<section><div> \n\t </div></section>'],
  ['hidden 文本', '<section hidden>private hidden text</section>'],
  ['display none 文本', '<section style="display:none"><span>hidden</span></section>'],
  ['visibility hidden 文本', '<section style="visibility:hidden">hidden</section>'],
  [
    '脚本与样式不是可见文本',
    '<script type="application/json">{}</script><style>.fixture{}</style>',
  ],
  ['输入值不是页面正文', '<input value="private-input">'],
])('[AC-F1-01e-WHITE#2] %s 判为白屏', (_label, html) => {
  const { report } = watch(rootWith(html));
  vi.advanceTimersByTime(3000);
  expect(report).toHaveBeenCalledTimes(1);
});

it.each([
  ['可见文本', '<section><span>ready</span></section>'],
  ['图片', '<section><img alt=""></section>'],
  ['SVG', '<section><svg aria-hidden="true"></svg></section>'],
  ['canvas', '<section><canvas></canvas></section>'],
])('[AC-F1-01e-WHITE#3] %s 已渲染则不上报', (_label, html) => {
  const { report } = watch(rootWith(html));
  vi.advanceTimersByTime(30_000);
  expect(report).not.toHaveBeenCalled();
});

it('[AC-F1-01e-WHITE#4] 到期读取实时 DOM：启动时空，3 秒内已渲染则不上报', () => {
  const root = rootWith('');
  const { report } = watch(root);
  vi.advanceTimersByTime(2999);
  root.innerHTML = '<article>ready</article>';
  vi.advanceTimersByTime(30_000);
  expect(report).not.toHaveBeenCalled();
});

it('[AC-F1-01e-WHITE#5] 到期读取实时 DOM：启动时有内容，到期被清空则上报', () => {
  const root = rootWith('<article>ready</article>');
  const { report } = watch(root);
  vi.advanceTimersByTime(2999);
  root.replaceChildren();
  vi.advanceTimersByTime(1);
  expect(report).toHaveBeenCalledTimes(1);
});

it.each([0, 2999])('[AC-F1-01e-WHITE#6] %ims 取消后不上报，重复取消安全', (delay) => {
  const { report, cancel } = watch(rootWith(''));
  vi.advanceTimersByTime(delay);
  cancel();
  cancel();
  vi.advanceTimersByTime(30_000);
  expect(report).not.toHaveBeenCalled();
});

it('[AC-F1-01e-WHITE#7] timeoutMs 可覆盖默认时长', () => {
  const { report } = watch(rootWith(''), 1250);
  vi.advanceTimersByTime(1249);
  expect(report).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(report).toHaveBeenCalledExactlyOnceWith({
    kind: 'whitescreen',
    path: '/rules',
    platform: null,
    version: null,
    elapsed_ms: 1250,
  });
});

it('[AC-F1-01e-WHITE#8] elapsed_ms 取注入时钟的实际差值，不直接写 timeoutMs', () => {
  let time = 8000;
  const report = vi.fn();
  const schedule = vi.fn((callback: () => void, delay: number) =>
    window.setTimeout(callback, delay),
  );
  startWhitescreenWatch({
    root: rootWith(''),
    report,
    env: { platform: 'ios', version: '1.2.3' },
    now: () => time,
    setTimeout: schedule,
  });
  expect(schedule).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 3000);
  time = 11_450;
  vi.advanceTimersByTime(3000);
  expect(report).toHaveBeenCalledExactlyOnceWith({
    kind: 'whitescreen',
    path: '/rules',
    platform: 'ios',
    version: '1.2.3',
    elapsed_ms: 3450,
  });
});

it('[AC-F1-01e-WHITE#9] 报告仅含白名单，URL 不带 query/hash，不带输入值或存储秘密', () => {
  window.history.replaceState(null, '', '/rules?token=fixture-query-token#fixture-hash');
  document.cookie = 'fixture_session=fixture-cookie-secret; Path=/';
  localStorage.setItem('token', 'fixture-storage-secret');
  const root = rootWith(
    '<input value="fixture-input-secret"><div hidden>fixture-hidden-secret</div>',
  );
  const report = vi.fn();
  const env = { platform: 'android', version: '2.0.0', token: 'fixture-env-secret' };
  startWhitescreenWatch({ root, report, env, now: () => performance.now() });
  vi.advanceTimersByTime(3000);
  expect(report).toHaveBeenCalledExactlyOnceWith({
    kind: 'whitescreen',
    path: '/rules',
    platform: 'android',
    version: '2.0.0',
    elapsed_ms: 3000,
  });
  const serialized = JSON.stringify(report.mock.calls);
  for (const secret of [
    'fixture-query-token',
    'fixture-hash',
    'fixture-cookie-secret',
    'fixture-storage-secret',
    'fixture-input-secret',
    'fixture-hidden-secret',
    'fixture-env-secret',
  ]) {
    expect(serialized).not.toContain(secret);
  }
});

it('[AC-F1-01e-WHITE#10] 只检查指定 root，其他区域有内容也不能掩盖白屏', () => {
  const sibling = document.createElement('aside');
  sibling.innerHTML = '<span>outside root</span><svg></svg>';
  document.body.append(sibling);
  const { report } = watch(rootWith('<div></div>'));
  vi.advanceTimersByTime(3000);
  expect(report).toHaveBeenCalledTimes(1);
});

it('[AC-F1-01e-WHITE#11] 未传 now 时也能用默认时钟完成首屏检测', () => {
  const report = vi.fn();
  startWhitescreenWatch({ root: rootWith(''), report, env: { platform: null, version: null } });
  vi.advanceTimersByTime(3000);
  expect(report).toHaveBeenCalledExactlyOnceWith({
    kind: 'whitescreen',
    path: '/rules',
    platform: null,
    version: null,
    elapsed_ms: 3000,
  });
});
