import { expect, it } from 'vitest';
import { contextOf } from '../wiring/context-kit.ts';
import { capture } from '../attribution/kit.ts';

it('[AC-B1-08t#24] worker 已注册的 order-sync 消费者把补偿任务路由到待处理扫描', async () => {
  // DummyDriver 只编译查询，不连接数据库，也不监听端口；验证真正的 worker 装配入口。
  const f = await contextOf('worker', true);
  try {
    const registrations = f.queue.register.mock.calls.filter(([queue]) => queue === 'order-sync');
    expect(registrations).toHaveLength(1);
    const handler = registrations[0]![1];
    f.queries.length = 0;
    const result = await capture(() =>
      handler({
        id: 'synthetic-snapshot-retry',
        queue: 'order-sync',
        name: 'snapshot-retry',
        payload: { app_id: 'app-a' },
        attempt: 1,
      }),
    );
    // 不能按 window 任务解析后丢弃，也不能只增加一个未接入 worker 的独立函数。
    expect(result).toMatchObject({ ok: true });
    expect(f.queries.some((query) => query.includes('order_sync_pending'))).toBe(true);
  } finally {
    await f.context.close();
  }
});
