import http from 'node:http';
import https from 'node:https';
import { expect, it, vi } from 'vitest';
import { createDemoMobPush } from '../../../../apps/api/src/modules/notification/infra/demo-mobpush.ts';

it.each(['accepted', 'rejected'] as const)(
  '[AC-B1-12o#1] 演示 MobPush 按预设返回 %s，不请求网络、不伪造平台响应',
  async (status) => {
    const forbid = () => {
      throw new Error('unexpected network request');
    };
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(forbid);
    const plain = vi.spyOn(http, 'request').mockImplementation(forbid);
    const secure = vi.spyOn(https, 'request').mockImplementation(forbid);
    try {
      const channel = createDemoMobPush({ status });
      const targets = [{ provider: 'mobpush', token: 'device-reg-a' }];
      const payload = { message_id: 'message-a', title: '标题', body: '正文' };
      for (let i = 0; i < 2; i += 1) {
        expect(await channel.send(targets, payload, new AbortController().signal)).toEqual({
          status,
        });
      }
      expect(fetch).not.toHaveBeenCalled();
      expect(plain).not.toHaveBeenCalled();
      expect(secure).not.toHaveBeenCalled();
      expect(payload).toEqual({ message_id: 'message-a', title: '标题', body: '正文' });
      expect(targets).toEqual([{ provider: 'mobpush', token: 'device-reg-a' }]);
    } finally {
      vi.restoreAllMocks();
    }
  },
);
