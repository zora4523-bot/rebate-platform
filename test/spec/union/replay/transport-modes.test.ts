import { expect, it, vi } from 'vitest';
import {
  createUnionReplayClient,
  type UnionEndpoint,
  type UnionTransport,
} from '../../../../apps/api/src/modules/union/index.ts';
import { platforms, recording, scenario } from './kit.ts';

it.each(['demo', 'live'] as const)(
  '[AC-B1-04c-TRANSPORT#5] %s 端点必须以明确错误拒绝回放且不调用传输',
  async (mode) => {
    const endpoints: readonly UnionEndpoint[] = platforms.map((platform) => ({
      platform,
      mode: platform === 'jd' ? mode : 'replay',
      baseUrl:
        platform === 'jd' && mode === 'demo'
          ? null
          : `https://${platform}.synthetic.invalid/synthetic-api/`,
      quotaKey: `synthetic:${platform}`,
    }));
    const transport = vi.fn<UnionTransport>().mockResolvedValue(recording().response);

    // Either client construction or sending may reject the non-replay mode.
    const operation = Promise.resolve().then(async () => {
      const client = createUnionReplayClient({ endpoints, transport });
      return client.send('jd', { method: 'GET', path: 'echo', scenario });
    });
    await expect(operation).rejects.toMatchObject({ code: 'unsafe_mode' });
    expect(transport).not.toHaveBeenCalled();
  },
);
