// B2-04wa: the durable alert port is required when the snapshot runner is assembled (D10-188 ①):
// without the entry's EVENT_BUS the assembly refuses to start instead of falling back to log lines.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  assembleAssetSnapshot,
  createAssetSnapshotAlertQueue,
  type AssetSnapshotAssembly,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import {
  DEADLINE,
  EXPOSURE,
  TIMED_OUT,
  TIMEOUT,
  close,
  contents,
  context,
  events,
  exposurePayload,
  input,
  jobs,
  open,
  receivable,
  refusal,
  snapshots,
  timedOutPayload,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

const REFUSED = { name: 'LedgerError', code: 'INVALID_INPUT' };

it(
  '[AC-B2-04wa#6] 未注入 EVENT_BUS 时启动失败：缺失、为空或没有 publish 即同步拒绝组装，且不读时钟、不读来源、不发布、不写库',
  async () => {
    const f = context(h, { now: DEADLINE, threshold: 0n });
    await receivable(h.db, f.appId, 'taobao', 1n);
    const now = vi.spyOn(f.clock, 'now');
    for (const bad of [undefined, null, {}, { publish: 'publish' }]) {
      expect(refusal(() => createAssetSnapshotAlertQueue(bad as never))).toEqual(REFUSED);
      expect(
        refusal(() => assembleAssetSnapshot({ ...f.dependencies, eventBus: bad as never })),
      ).toEqual(REFUSED);
    }
    // No eventBus key at all: how an entry without the port would assemble it.
    expect(
      refusal(() => assembleAssetSnapshot(f.dependencies as unknown as AssetSnapshotAssembly)),
    ).toEqual(REFUSED);
    expect(now).not.toHaveBeenCalled();
    expect(f.readAppTotals).not.toHaveBeenCalled();
    expect(f.getAdvanceAlertFen).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    expect(await snapshots(h.db, f.appId)).toEqual([]);
    expect(await events(h.db, f.appId)).toEqual([]);
  },
  TIMEOUT,
);

it(
  '[AC-B2-04wa#7] 组装出的运行器只经注入的 EVENT_BUS 在快照写事务里入队两个告警，创建时不发布；再次组装重放不重复入队',
  async () => {
    const f = context(h, { now: DEADLINE, threshold: 0n });
    await receivable(h.db, f.appId, 'taobao', 3n);
    const eventBus = { publish: f.publish };
    const runner = assembleAssetSnapshot({ ...f.dependencies, eventBus });
    expect(f.publish).not.toHaveBeenCalled();
    await runner.run(h.db, input(f.appId));
    expect(f.publish).toHaveBeenCalledTimes(2);
    const [trx, other] = f.publish.mock.calls.map((call) => call[0]);
    expect(other).toBe(trx);
    expect(trx?.isTransaction).toBe(true);
    const rows = await events(h.db, f.appId);
    expect(contents(rows)).toEqual([
      { name: TIMED_OUT, payload: { v: 1, data: timedOutPayload(f.appId) } },
      { name: EXPOSURE, payload: { v: 1, data: exposurePayload(f.appId, 3, 0) } },
    ]);
    expect(await jobs(h.db, f.appId)).toHaveLength(2);

    await assembleAssetSnapshot({ ...f.dependencies, eventBus }).run(h.db, input(f.appId));
    expect(await events(h.db, f.appId)).toEqual(rows);
    expect(await jobs(h.db, f.appId)).toHaveLength(2);
    expect(await snapshots(h.db, f.appId)).toHaveLength(1);
  },
  TIMEOUT,
);
