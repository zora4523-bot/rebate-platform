import { expect, it } from 'vitest';
import { createDemoMobPush } from './demo-mobpush.ts';

const targets = [{ provider: 'mobpush', token: 'device-reg-a' }];
const payload = { message_id: 'message-a', title: '标题', body: '正文' };

it('[AC-B1-12o#1] the demo channel answers its preset and nothing else', async () => {
  const accepted = createDemoMobPush({ status: 'accepted' });
  const rejected = createDemoMobPush({ status: 'rejected' });
  await expect(
    accepted.send(targets, payload, new AbortController().signal),
  ).resolves.toStrictEqual({ status: 'accepted' });
  await expect(
    rejected.send(targets, payload, new AbortController().signal),
  ).resolves.toStrictEqual({ status: 'rejected' });
});

it('[AC-B1-12o#1] an aborted call rejects instead of answering', async () => {
  const controller = new AbortController();
  controller.abort(new Error('fixture abort'));
  await expect(
    createDemoMobPush({ status: 'accepted' }).send(targets, payload, controller.signal),
  ).rejects.toThrow('fixture abort');
});
