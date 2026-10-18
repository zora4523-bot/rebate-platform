import { expect, it, vi } from 'vitest';
import { createRootLogger, type TokenPrincipal } from '../../../platform/index.ts';
import { PendingTrackError, PendingTracks } from '../../application/pending-tracks.ts';
import { PendingTracksController } from './pending-tracks.controller.ts';

const TRACE = '0199a3b4-5c6d-7000-8000-0000000000bb';
const LINK = '0199a3b4-5c6d-7000-8000-0000000000c1';
const ATTEMPT = '0199a3b4-5c6d-7000-8000-0000000000c2';
const principal = {
  uid: '0199a3b4-5c6d-7000-8000-0000000000c3',
  app_id: 'pending_unit_app',
  sid: '0199a3b4-5c6d-7000-8000-0000000000c4',
  device_id: '0199a3b4-5c6d-7000-8000-0000000000c5',
  scp: 'full',
} as unknown as TokenPrincipal;

function setup(dismiss: PendingTracks['dismiss'] = async () => undefined) {
  const lines: string[] = [];
  const logger = createRootLogger(
    { entry: 'api', appEnv: 'test', level: 'info' },
    { write: (line: string) => void lines.push(line) },
  );
  const tracks = Object.assign(new PendingTracks(), {
    list: vi.fn<PendingTracks['list']>(async () => ({ items: [] })),
    dismiss: vi.fn<PendingTracks['dismiss']>(dismiss),
  });
  return { tracks, lines, controller: new PendingTracksController(tracks, logger) };
}

it('[AC-B1-08m#20] 没有 token 主体时 401 / 10001，不调用查询', async () => {
  const { tracks, controller } = setup();
  await expect(controller.list({ id: TRACE })).rejects.toMatchObject({
    status: 401,
    response: { code: 10001, trace_id: TRACE },
  });
  await expect(
    controller.dismiss({ id: TRACE, body: { attempt_id: ATTEMPT } }, LINK),
  ).rejects.toMatchObject({ status: 401 });
  expect(tracks.list).not.toHaveBeenCalled();
  expect(tracks.dismiss).not.toHaveBeenCalled();
});

it('[AC-B1-08m#24] 查询拒绝的关闭映射为 400 / 20001 fields=[attempt_id]，日志只有平铺字段', async () => {
  const { tracks, controller, lines } = setup(async () => {
    throw new PendingTrackError(['attempt_id']);
  });
  await expect(
    controller.dismiss({ id: TRACE, principal, body: { attempt_id: ATTEMPT } }, LINK),
  ).rejects.toMatchObject({
    status: 400,
    response: { code: 20001, data: { fields: ['attempt_id'] }, trace_id: TRACE },
  });
  expect(tracks.dismiss).toHaveBeenCalledExactlyOnceWith(
    { app_id: 'pending_unit_app', user_id: principal.uid },
    LINK,
    ATTEMPT,
  );
  const record = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
  expect(record).toMatchObject({
    module: 'orders',
    app_id: 'pending_unit_app',
    outcome: 'not_found',
  });
  expect(JSON.stringify(record)).not.toContain(LINK);
  expect(JSON.stringify(record)).not.toContain(principal.uid);
});

it('[AC-B1-08m#21] 主体存在但缺 attempt_id 时也是 20001，且不调用关闭', async () => {
  const { tracks, controller } = setup();
  await expect(controller.dismiss({ id: TRACE, principal, body: {} }, LINK)).rejects.toMatchObject({
    status: 400,
    response: { code: 20001, data: { fields: ['attempt_id'] } },
  });
  expect(tracks.dismiss).not.toHaveBeenCalled();
});

it('[AC-B1-08m#19] 其他错误原样抛出，不伪装成参数错误', async () => {
  const failure = new Error('database unavailable');
  const { controller } = setup(async () => {
    throw failure;
  });
  await expect(
    controller.dismiss({ id: TRACE, principal, body: { attempt_id: ATTEMPT } }, LINK),
  ).rejects.toBe(failure);
});

it('[AC-B1-08m#31] 未接数据库的基类在首次使用时失败关闭', async () => {
  const base = new PendingTracks();
  await expect(base.list({ app_id: 'a', user_id: 'b' })).rejects.toThrow(/need the database/);
  await expect(base.dismiss({ app_id: 'a', user_id: 'b' }, LINK, ATTEMPT)).rejects.toThrow(
    /need the database/,
  );
});
