// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BridgeMethods, BridgeRequest, BridgeTransport } from '@couli/bridge-sdk';

const entry = vi.hoisted(() => ({
  render: vi.fn(),
  report: vi.fn(),
  shell: vi.fn(() => null),
}));

// 隔离 React 的渲染调度，保留真实 main.tsx、检测器与 bridge-sdk。
// 空 root 模拟首次渲染未成功；没有网络或真实原生容器。
vi.mock('react-dom/client', () => ({
  createRoot: vi.fn(() => ({ render: entry.render, unmount: vi.fn() })),
}));
vi.mock('../../../../apps/h5/src/entries/app/shell.ts', () => ({ createAppShell: entry.shell }));
vi.mock('../../../../apps/h5/src/shared/whitescreen/report.ts', () => ({
  defaultReport: entry.report,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal('__REBATE_BRIDGE__', undefined);
  document.body.innerHTML = '<div id="root"></div>';
  window.history.replaceState(null, '', '/rules?token=fixture-entry-secret#private-anchor');
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
});

function nativeEnv(platform: BridgeMethods['app.getEnv']['result']['platform']) {
  const result: BridgeMethods['app.getEnv']['result'] = {
    platform,
    app_version: '3.2.1',
    build: 'fixture-build',
    os_version: 'fixture-os',
    bridge_version: 1,
    safe_area: { top: 0, bottom: 0, left: 0, right: 0 },
    channel: 'official',
  };
  return result;
}

function installBridge(
  methods: string[],
  fail = false,
  platform: 'ios' | 'android' | 'harmony' = 'ios',
) {
  const postMessage = vi.fn((request: BridgeRequest) => ({
    id: request.id,
    code: fail ? (90500 as const) : (0 as const),
    msg: fail ? 'fixture-native-error-private' : '',
    data: nativeEnv(platform),
  }));
  const bridge: BridgeTransport = { version: 1, methods, postMessage, subscribe: () => () => {} };
  vi.stubGlobal('__REBATE_BRIDGE__', bridge);
  return postMessage;
}

async function bootUntilDeadline() {
  await import('../../../../apps/h5/src/entries/app/main.tsx');
  // app.getEnv 经真实 SDK 返回 Promise，先排空微任务，不推进 3 秒时钟。
  await vi.advanceTimersByTimeAsync(0);
  expect(entry.render).toHaveBeenCalledTimes(1);
  expect(entry.report).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2999);
  expect(entry.report).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
}

it('[AC-F1-01e-ENTRY#1] App 外入口挂载后启动检测，3 秒向注入上报口发送 null 环境', async () => {
  await bootUntilDeadline();
  expect(entry.report).toHaveBeenCalledExactlyOnceWith({
    kind: 'whitescreen',
    path: '/rules',
    platform: null,
    version: null,
    elapsed_ms: 3000,
  });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(entry.report).toHaveBeenCalledTimes(1);
});

it.each(['ios', 'android', 'harmony'] as const)(
  '[AC-F1-01e-ENTRY#2] %s 通过 has 后从 app.getEnv 读取 platform 和 app_version',
  async (platform) => {
    const postMessage = installBridge(['app.getEnv'], false, platform);
    await bootUntilDeadline();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0]?.[0]).toMatchObject({ method: 'app.getEnv', params: {} });
    expect(entry.report).toHaveBeenCalledExactlyOnceWith({
      kind: 'whitescreen',
      path: '/rules',
      platform,
      version: '3.2.1',
      elapsed_ms: 3000,
    });
  },
);

it('[AC-F1-01e-ENTRY#3] 桥未声明 app.getEnv 时不调用原生，仍以 null 环境检测', async () => {
  const postMessage = installBridge([]);
  await bootUntilDeadline();
  expect(postMessage).not.toHaveBeenCalled();
  expect(entry.report).toHaveBeenCalledExactlyOnceWith({
    kind: 'whitescreen',
    path: '/rules',
    platform: null,
    version: null,
    elapsed_ms: 3000,
  });
});

it('[AC-F1-01e-ENTRY#4] 获取环境失败不妨碍白屏检测，不泄露原生错误内容', async () => {
  const postMessage = installBridge(['app.getEnv'], true);
  await bootUntilDeadline();
  expect(postMessage).toHaveBeenCalledTimes(1);
  expect(entry.report).toHaveBeenCalledExactlyOnceWith({
    kind: 'whitescreen',
    path: '/rules',
    platform: null,
    version: null,
    elapsed_ms: 3000,
  });
});

it('[AC-F1-01e-ENTRY#5] 入口实际把挂载 root 交给检测器，首屏成功则不上报', async () => {
  const detector = await import('../../../../apps/h5/src/shared/whitescreen/index.ts');
  const start = vi.spyOn(detector, 'startWhitescreenWatch');
  entry.render.mockImplementationOnce(() => {
    document.getElementById('root')!.innerHTML = '<article>ready</article>';
  });
  await bootUntilDeadline();
  // 仍要求入口启动检测，防止「完全未接线」让本例成为伪绿。
  expect(start).toHaveBeenCalledTimes(1);
  expect(start.mock.calls[0]?.[0].root).toBe(document.getElementById('root'));
  expect(entry.report).not.toHaveBeenCalled();
});
