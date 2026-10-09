import { afterAll, beforeAll, it } from 'vitest';
import { acquire, admitted, IP, refused, withRisk, type Server } from './kit.ts';

let server: Server;
beforeAll(async () => {
  server = await acquire();
}, 180_000);
afterAll(async () => {
  await server?.stop();
});

it('[AC-B1-03f#26] 毫秒时钟 Retry-After 向上取整，闭区间边界后一毫秒恢复', async () => {
  await withRisk(server, async (f) => {
    f.config('device.ip_register_per_hour', 1);
    const service = f.service();
    const input = { appId: f.app, clientIp: IP };
    f.clock.set('2031-05-06T09:00:00.400Z');
    admitted(await service.reserve(input));
    refused(await service.reserve(input), 3601);

    f.clock.set('2031-05-06T09:00:00.900Z');
    // ceil((09:00:00.400 + 3601 seconds - 09:00:00.900) / 1 second) = 3601.
    refused(await service.reserve(input), 3601);
    f.clock.set('2031-05-06T10:00:00.399Z');
    refused(await service.reserve(input), 2);
    f.clock.set('2031-05-06T10:00:00.400Z');
    refused(await service.reserve(input), 1);
    f.clock.advanceMs(1);
    admitted(await service.reserve(input));
  });
});
