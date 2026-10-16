// Helpers of the F1-10c rule tests: AdminOperationGuard with a list of permission points and
// read-only operations. Built on the frozen F1-06u kit (test/spec/admin/guard-mount/kit.ts),
// which is only imported here: its probe route spreads `s.selection` into every guard.run call,
// so a test switches the selection (permission list, readOnly) between requests.
import { vi } from 'vitest';
import type {
  AdminActor,
  AdminOperationInput,
} from '../../../../apps/api/src/modules/platform/http/admin-guard.ts';
import * as redisModule from '../../../../apps/api/src/modules/platform/redis/index.ts';
import type { Harness } from '../auth/kit.ts';
import { setup } from '../guard-mount/kit.ts';

export { allowed, rejected, TRACE } from '../guard-mount/kit.ts';

/** What the business module passes to guard.run besides the request. */
export type Selection = Omit<AdminOperationInput, 'request'>;

export type Scenario = Awaited<ReturnType<typeof setup>>;

/** Replaces the selection the probe route spreads into guard.run (no stale keys survive). */
export function select(s: Scenario, selection: Selection): void {
  const target = s.selection as Record<string, unknown>;
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, selection);
}

/**
 * The frozen setup with explicit grants; `selection` is in force before the first request.
 * The kit needs a string permission to start with; its default grants are never used here.
 */
export async function scenario(
  h: Harness,
  options: {
    selection: Selection;
    grants: readonly string[];
    isSuper?: boolean;
    phone?: boolean;
  },
): Promise<Scenario> {
  const s = await setup(h, {
    grants: options.grants,
    ...(options.isSuper === undefined ? {} : { isSuper: options.isSuper }),
    ...(options.phone === undefined ? {} : { phone: options.phone }),
  });
  select(s, options.selection);
  return s;
}

export function actorOf(s: Scenario, isSuper = false): AdminActor {
  return {
    adminId: s.a.id,
    appId: 'couli',
    isSuper,
    loginName: s.a.username,
  };
}

/**
 * Records every call on the `admin-step-up` Redis namespace (the step-up tokens), from the
 * handle's construction on, like AC-F1-06u#7. Call before `scenario`; restore in `finally`.
 */
export function watchStepUpRedis() {
  const create = redisModule.createRedisHandle;
  const touched = vi.fn<(call: 'get' | 'set' | 'eval') => void>();
  const factory = vi.spyOn(redisModule, 'createRedisHandle').mockImplementation(async (...args) => {
    const handle = await create(...args);
    if (handle === null) return null;
    return {
      namespace(name) {
        const namespace = handle.namespace(name);
        if (name !== 'admin-step-up') return namespace;
        return {
          get(key) {
            touched('get');
            return namespace.get(key);
          },
          set(key, value, ttl) {
            touched('set');
            return namespace.set(key, value, ttl);
          },
          eval(script, options) {
            touched('eval');
            return namespace.eval(script, options);
          },
        };
      },
      close: () => handle.close(),
      onApplicationShutdown: () => handle.onApplicationShutdown(),
    };
  });
  return { touched, restore: () => factory.mockRestore() };
}
