// Real platform adapters before 规划/09 CAP-TB-10 / CAP-JD-10 / CAP-PDD-10 are recorded: a
// whitelisted channel of taobao, jd or pdd is answered as a union outage (UnionError
// upstream_unavailable) without any union request — no credentials read, no query identity, no
// transport call, no invented payload. The live Pinduoduo adapter is assembled with a transport
// double that only counts; the jd / taobao entries are the registered placeholders.
import { expect, it } from 'vitest';
import {
  FixedClock,
  type MaterialChannelsSpec,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  UnionError,
  createUnionChannelRanking,
  createUnionRegistry,
  isRegisteredPlatform,
  type CallCtx,
  type Platform,
  type UnionAdapter,
  type UnionChannelRanking,
  type UnionRegistry,
  type UnionTransport,
} from '../../../../apps/api/src/modules/union/index.ts';
import {
  APP,
  JD_CHANNEL,
  NOW,
  PDD_CHANNEL,
  SECRET,
  TB_CHANNEL,
  channel,
  ctxFor,
  pageInput,
  rejection,
} from './kit.ts';

const CHANNEL_OF = { taobao: TB_CHANNEL, jd: JD_CHANNEL, pdd: PDD_CHANNEL } as const;
const SPEC: MaterialChannelsSpec = {
  version: 'synthetic-platforms',
  channels: [channel('taobao', TB_CHANNEL), channel('jd', JD_CHANNEL), channel('pdd', PDD_CHANNEL)],
};

function portOver(registry: UnionRegistry): UnionChannelRanking {
  return createUnionChannelRanking({
    adapterFor: (platform: Platform) =>
      isRegisteredPlatform(platform) ? registry.get(platform) : undefined,
    channels: () => SPEC,
    callCtx: (input) => ctxFor(input.appId, input.platform),
    logger: { warn: () => undefined },
  });
}

/** Live Pinduoduo assembly whose every dependency only counts (nothing reaches a network). */
function liveRegistry() {
  const counts = { transport: 0, credentials: 0, identity: 0 };
  const transport: UnionTransport = async () => {
    counts.transport += 1;
    throw new Error('synthetic transport: no union request may be sent');
  };
  const registry = createUnionRegistry({
    endpoints: [
      {
        platform: 'jd',
        mode: 'live',
        baseUrl: 'https://jd.invalid/router',
        quotaKey: 'synthetic:jd',
      },
      {
        platform: 'pdd',
        mode: 'live',
        baseUrl: 'https://pdd.invalid/router',
        quotaKey: 'synthetic:pdd',
      },
      {
        platform: 'taobao',
        mode: 'live',
        baseUrl: 'https://taobao.invalid/router',
        quotaKey: 'synthetic:taobao',
      },
    ],
    environment: 'staging',
    seed: 'synthetic-rank',
    clock: new FixedClock(NOW),
    pddLive: {
      credentials: async () => {
        counts.credentials += 1;
        return { clientId: 'SYNTHETIC_CLIENT_ID', clientSecret: SECRET };
      },
      transport,
      queryIdentity: async () => {
        counts.identity += 1;
        return { pid: 'synthetic_pid', customParameters: '{"synthetic":1}' };
      },
    },
  });
  return { registry, counts };
}

async function expectOutage(port: UnionChannelRanking, platform: 'taobao' | 'jd' | 'pdd') {
  const channelId = CHANNEL_OF[platform];
  for (const action of [
    () => port.categories({ appId: APP, platform, channelId }),
    () => port.page(pageInput({ platform, channelId })),
  ]) {
    const error = await rejection(action);
    expect(error).toBeInstanceOf(UnionError);
    expect(error).toMatchObject({ code: 'upstream_unavailable', platform });
  }
}

/**
 * A direct call of the adapter's own channel method, when it has one: 'absent', or the code it
 * failed with. Both are allowed before CAP-*-10; data is not.
 */
async function directOutcome(adapter: UnionAdapter, ctx: CallCtx): Promise<string[]> {
  const outcomes: string[] = [];
  const categories = adapter.channelCategories;
  const ranking = adapter.channelRanking;
  const results = [
    categories === undefined
      ? 'absent'
      : await rejection(() => categories.call(adapter, { channelId: 'synthetic' }, ctx)),
    ranking === undefined
      ? 'absent'
      : await rejection(() =>
          ranking.call(
            adapter,
            { channelId: 'synthetic', categoryId: null, pageNo: 1, pageSize: 20 },
            ctx,
          ),
        ),
  ];
  for (const result of results) {
    if (result === 'absent') outcomes.push('absent');
    else if (result instanceof UnionError) outcomes.push(result.code);
    else outcomes.push(`not a union outage: ${String(result)}`);
  }
  return outcomes;
}

it.each(['taobao', 'jd', 'pdd'] as const)(
  '[AC-B1-22p#18][BR-TEXT-17] 未接入的 %s 适配器（登记表占位）：白名单内的频道也按联盟故障答 upstream_unavailable',
  async (platform) => {
    const registry = createUnionRegistry();
    await expectOutage(portOver(registry), platform);
    for (const outcome of await directOutcome(registry.get(platform), ctxFor(APP, platform))) {
      expect(['absent', 'upstream_unavailable']).toContain(outcome);
    }
  },
);

it('[AC-B1-22p#19][BR-TEXT-17] 拼多多真实适配器（live）在 CAP-PDD-10 实测前：类目与榜单答 upstream_unavailable，不取凭据、不取查询身份、不发任何请求', async () => {
  const { registry, counts } = liveRegistry();
  expect(registry.registrations()).toContainEqual({ platform: 'pdd', implemented: true });
  await expectOutage(portOver(registry), 'pdd');
  for (const outcome of await directOutcome(registry.get('pdd'), ctxFor(APP, 'pdd'))) {
    expect(['absent', 'upstream_unavailable']).toContain(outcome);
  }
  expect(counts).toEqual({ transport: 0, credentials: 0, identity: 0 });
});

it.each(['taobao', 'jd'] as const)(
  '[AC-B1-22p#20][BR-TEXT-17] live 装配下的 %s（CAP-*-10 未实测）：答 upstream_unavailable，拼多多的传输也不被碰',
  async (platform) => {
    const { registry, counts } = liveRegistry();
    await expectOutage(portOver(registry), platform);
    for (const outcome of await directOutcome(registry.get(platform), ctxFor(APP, platform))) {
      expect(['absent', 'upstream_unavailable']).toContain(outcome);
    }
    expect(counts).toEqual({ transport: 0, credentials: 0, identity: 0 });
  },
);
