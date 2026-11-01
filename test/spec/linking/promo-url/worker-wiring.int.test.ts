// B1-06zd rule test: the worker entry works the prefetch jobs (D10-510). A job nobody consumes would
// leave the switch on with no effect, so the real AppModule of the worker entry must register the
// handler on the job's queue, over its own governed union; only DemoUnionAdapter's convert is a stub.
import { createTestDatabase } from '@couli/db/testing';
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { DemoUnionAdapter } from '../../../../apps/api/src/modules/union/index.ts';
import { privilegeLinkParameters } from '../../../../apps/api/src/modules/union/infra/taobao/privilege-link.ts';
import { assembled, handlersOf } from '../../risk/appeal-restore/worker-kit.ts';
import { COUPON_CLICK_URL, JOB_NAME, QUEUE_NAME, promotion } from './kit.ts';
import { jobFixture, jobOf } from './job-kit.ts';

let database: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
let db: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
}, 180_000);

afterAll(async () => {
  try {
    await destroyDb(db);
  } finally {
    await database?.drop();
  }
}, 60_000);

it('[AC-B1-06zd#42] worker 入口在任务的队列上注册处理器：跑一个任务，经该入口的联盟转链并写回 promo_url', async () => {
  const f = await jobFixture(db);
  const { userId, relation } = await f.bound();
  const linkId = await f.link({ userId, relationId: relation });
  const convert = vi
    .spyOn(DemoUnionAdapter.prototype, 'convert')
    .mockImplementation(async (request, identity) => {
      privilegeLinkParameters(request, identity);
      return promotion();
    });
  const app = await assembled('worker', db, f.clock);
  try {
    const handlers = handlersOf(app, QUEUE_NAME);
    expect(handlers).toHaveLength(1);

    await handlers[0]!({
      id: randomUUID(),
      queue: QUEUE_NAME,
      name: JOB_NAME,
      payload: jobOf(f.appId, linkId),
      attempt: 1,
    });

    expect(convert).toHaveBeenCalledOnce();
    expect((await f.row(linkId)).promo_url).toBe(COUPON_CLICK_URL);
  } finally {
    await app.close();
    convert.mockRestore();
  }
}, 120_000);
