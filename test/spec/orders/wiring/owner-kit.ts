import { AsyncLocalStorage } from 'node:async_hooks';

// D10-363：worker 装配里别的模块也会起定时器、发查询（如 B2-15m payment 的 bill.recon 链：启动后
// 15 秒首次播种、此后每 5 分钟一次，查 pay_orders / pay_anomalies）。订单接线测试只数 orders 的：
// 定时器创建时调用栈里有 orders 源码帧，或创建于 run() 之内，才归 orders；归 orders 的定时器回调
// 也在 run() 之内执行。查询只收 run() 之内发出的（测试调 orders 运行时入口用 run() 包住）。
// 别的模块的定时器与查询不计入；orders 自己的个数、周期与查询照旧精确断言。
const ORDERS_SOURCE = /[\\/]apps[\\/]api[\\/]src[\\/]modules[\\/]orders[\\/]/;
const KINDS = [
  ['setTimeout', 'clearTimeout', true],
  ['setInterval', 'clearInterval', false],
  ['setImmediate', 'clearImmediate', true],
] as const;

type Call = (...args: unknown[]) => unknown;
type Timers = Record<(typeof KINDS)[number][0 | 1], Call>;

/** 在 vi.useFakeTimers() 之后、装配之前调用；测试结束前 restore()。 */
export function ordersTimers() {
  const scope = new AsyncLocalStorage<true>();
  const timers = globalThis as unknown as Timers;
  const live = new Set<unknown>();
  const periods: number[] = [];
  const restores: (() => void)[] = [];
  const owned = (): boolean => {
    if (scope.getStore() === true) return true;
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 100;
    const stack = new Error().stack ?? '';
    Error.stackTraceLimit = limit;
    return ORDERS_SOURCE.test(stack);
  };
  for (const [set, clear, once] of KINDS) {
    const arm = timers[set];
    const disarm = timers[clear];
    timers[set] = (callback, ...rest) => {
      if (typeof callback !== 'function' || !owned()) return arm(callback, ...rest);
      if (set !== 'setImmediate') periods.push(Number(rest[0] ?? 0));
      const call = callback as Call;
      const handle: unknown = arm(
        (...args: unknown[]) => {
          if (once) live.delete(handle);
          return scope.run(true, () => call(...args));
        },
        ...rest,
      );
      live.add(handle);
      return handle;
    };
    timers[clear] = (handle) => {
      live.delete(handle);
      return disarm(handle);
    };
    restores.push(() => {
      timers[set] = arm;
      timers[clear] = disarm;
    });
  }
  return {
    /** orders 在途的定时器个数（vi.getTimerCount() 里属于 orders 的部分）。 */
    count: () => live.size,
    /** orders 调 setTimeout / setInterval 时给的周期（毫秒），按调用顺序。 */
    periods: () => [...periods],
    /** 在 orders 名下执行（测试调 orders 运行时的 start / stop）。 */
    run: <T>(action: () => T): T => scope.run(true, action),
    /** 此后记入 queries 的语句中，在 orders 名下发出的那些。 */
    watch(queries: string[]): () => string[] {
      const ours: string[] = [];
      const push = queries.push.bind(queries);
      Object.defineProperty(queries, 'push', {
        configurable: true,
        value: (...items: string[]) => {
          if (scope.getStore() === true) ours.push(...items);
          return push(...items);
        },
      });
      restores.push(() => {
        delete (queries as { push?: unknown }).push;
      });
      return () => [...ours];
    },
    restore() {
      for (const undo of restores.splice(0).reverse()) undo();
    },
  };
}
