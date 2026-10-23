// B1-28f (brief B.5): app.module assembles deletionCleanupPorts.catalog as catalog's cleanup step
// instead of the DeletionCleanupUnavailable marker. Read from the worker options app.module really
// passes to IdentityDeletionExpiryModule.forWorker (captured, the module is not built); no database.
import { afterEach, expect, it, vi } from 'vitest';
import { capturedWorkerOptions, identity, ports } from '../../identity/deletion-processing/kit.ts';
import { assembledCleanup } from './kit.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

it('[AC-B1-28f#7] 装配：worker 的 deletionCleanupPorts.catalog 是清理步骤函数，不再是 unavailable 标记', async () => {
  const api = await identity();
  const p = await ports();
  const cleanup = assembledCleanup(await capturedWorkerOptions(api, p), p);
  expect(
    cleanup.catalog,
    'catalog is still a DeletionCleanupUnavailable marker',
  ).not.toHaveProperty('unavailable');
  expect(cleanup.catalog).toBeTypeOf('function');
}, 30_000);
