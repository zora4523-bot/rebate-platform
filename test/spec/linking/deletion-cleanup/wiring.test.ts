// B1-06zc: app.module's assembly of identity's deletion cleanup ports on the worker entry. The
// linking port is linking/index.ts's blockForDeletion, no longer the { unavailable: 'W1' } marker
// (which kept every deletion request in processing with a daily cleanup_blocked line); growth's
// shipped port stays as it was. The options are captured from IdentityDeletionExpiryModule
// .forWorker (the module is not built, nothing connects).
import { expect, it } from 'vitest';
import type {
  DeletionCleanupPorts,
  DeletionCleanupStep,
} from '../../../../apps/api/src/modules/identity/ports/deletion-cleanup.ts';
import { blockForDeletion } from '../../../../apps/api/src/modules/linking/index.ts';
import {
  capturedWorkerOptions,
  growthDetach,
  identity,
  ports,
} from '../../identity/deletion-processing/kit.ts';

interface CleanupProvider {
  readonly inject?: readonly unknown[];
  readonly useFactory: (...dependencies: unknown[]) => DeletionCleanupPorts;
}

it('[AC-B1-06zc#9] 装配：worker 的注销清理端口 linking 换成 linking/index.ts 导出的 blockForDeletion（DeletionCleanupStep），不再是 unavailable 标记；growth 端口不变', async () => {
  expect(blockForDeletion satisfies DeletionCleanupStep).toBeTypeOf('function');
  const api = await identity();
  const p = await ports();
  const options = (await capturedWorkerOptions(api, p)) as { cleanup?: CleanupProvider };
  expect(options.cleanup, 'app.module passes no cleanup ports').toMatchObject({
    useFactory: expect.any(Function),
  });
  const provider = options.cleanup!;
  const known = new Map<unknown, unknown>([
    [p.platform.CLOCK, p.clock],
    [p.platform.ROOT_LOGGER, p.logger],
  ]);
  const cleanup = provider.useFactory(...(provider.inject ?? []).map((token) => known.get(token)));
  expect(cleanup.linking, 'linking is still an unavailable marker').not.toHaveProperty(
    'unavailable',
  );
  expect(cleanup.linking).toBe(blockForDeletion);
  expect(cleanup.growth).toBe(await growthDetach());
});
