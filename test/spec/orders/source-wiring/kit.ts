import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import type { OrderSourcePorts } from '../../../../apps/api/src/modules/orders/index.ts';
import type { RegisteredPlatform } from '../../../../apps/api/src/modules/union/index.ts';
import * as pipeline from '../../../../apps/api/src/modules/orders/application/pipeline-port.ts';
import * as update from '../../../../apps/api/src/modules/orders/application/update-step.ts';
import { contextOf, runtime } from '../wiring/context-kit.ts';
import { built } from '../wiring/db-kit.ts';

// D10-76：只描述新增接口；旧接口和已有实现均不改。实现时将此接口并入 OrderSourcePorts。
export interface SourceConfig {
  clickCodeEnabled: boolean;
  backfillWindowHours: number;
}
export type ConfiguredSources = OrderSourcePorts & {
  sourceConfig(appId: string, platform: RegisteredPlatform): SourceConfig | Promise<SourceConfig>;
};

export async function wired(db?: Kysely<DB>) {
  const makePipeline = vi.spyOn(pipeline, 'createOrderPipeline');
  const makeUpdate = vi.spyOn(update, 'createOrderUpdateStep');
  const f = await built(() => contextOf('worker', true, db));
  try {
    const r = await built(() => runtime(f.context));
    expect(makePipeline).toHaveBeenCalledTimes(1);
    expect(makeUpdate).toHaveBeenCalledTimes(1);
    const deps = makePipeline.mock.calls[0]![0];
    const updateDeps = makeUpdate.mock.calls[0]![0];
    expect(deps.sources).toMatchObject({
      linkLogs: expect.any(Function),
      productKey: expect.any(Function),
      sourceConfig: expect.any(Function),
    });
    return { ...f, r, deps, updateDeps, sources: deps.sources as ConfiguredSources };
  } catch (error) {
    await f.context.close();
    throw error;
  }
}
