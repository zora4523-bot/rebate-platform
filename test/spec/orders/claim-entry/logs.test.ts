import { expect, it } from 'vitest';
import type { ClaimEntryLog } from '../../../../apps/api/src/modules/linking/index.ts';
import { ago, HOUR, MINUTE, log, otherUser, pinned, subject } from './kit.ts';

const excluded: [number, string, Partial<ClaimEntryLog>][] = [
  [20, 'precompute', { event: 'precompute' }],
  [21, 'register', { event: 'register' }],
  [22, '失败结果', { result_code: 30151 }],
  [23, '分享', { pid_scene: 'share' }],
  [24, '本人链接由他人打开', { opener_user_id: otherUser }],
  [25, '无opener回退为他人', { opener_user_id: null, user_id: otherUser }],
  [26, '他App', { app_id: 'foreign-app' }],
  [27, '未来记录', { created_at: ago(-1) }],
  [28, '匿名记录', { user_id: null, opener_user_id: null }],
];
it.each(excluded)(
  '[AC-B1-10h#%s] AC-S1-25② %s不计入也不遮挡更早有效外跳',
  async (_n, _label, patch) => {
    expect(await pinned({ logs: [log(patch)] })).toBe(false);
    const recentIgnored = log({ id: 2n, created_at: ago(10 * MINUTE), ...patch });
    expect(await pinned({ logs: [log(), recentIgnored] })).toBe(true);
  },
);

it.each([
  [29, 'convert无opener回退本人', { event: 'convert', opener_user_id: null }],
  [30, 'pid_scene为空', { pid_scene: null }],
  [31, '他人非分享链接由本人打开', { user_id: otherUser }],
  [32, '链接快照无用户但打开者本人', { user_id: null }],
] satisfies [number, string, Partial<ClaimEntryLog>][])(
  '[AC-B1-10h#%s] AC-S1-25② %s计入',
  async (_n, _label, patch) => {
    const result = await pinned({ logs: [log(patch)] });
    expect(result).toBe(true);
  },
);

it('[AC-B1-10h#33] AC-S1-25② 正常返利不依赖平台授权；各平台合并取最近', async () => {
  for (const platform of ['taobao', 'pdd', 'jd', 'meituan', 'vip', 'douyin']) {
    expect(await pinned({ logs: [log({ platform })], bindings: [] })).toBe(true);
  }
  const recent = log({ id: 2n, platform: 'jd', created_at: ago(5 * MINUTE) });
  expect(await pinned({ logs: [log({ created_at: ago(2 * HOUR) }), recent] })).toBe(false);
  expect(await pinned({ logs: [log({ opener_user_id: subject.user_id })] })).toBe(true);
});
