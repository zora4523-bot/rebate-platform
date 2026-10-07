import { afterEach, expect, it, vi } from 'vitest';
import * as catalogPublic from '../../../../apps/api/src/modules/catalog/index.ts';
import {
  CatalogModule,
  LinkRegistrar,
  RebateQuoter,
  type RegisterLinkInput,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import {
  LINK_REGISTRATIONS,
  LinkingModule,
  type RegistrationContext,
} from '../../../../apps/api/src/modules/linking/index.ts';
import { candidate, fixture, observed } from '../search/kit.ts';
import { createApp, type HttpApp } from './http-kit.ts';

// The probe lives INSIDE CatalogModule: resolving these dependencies at the root would not
// prove that app.module made linking's registrar and the demo quoter visible to catalog.
class SearchPorts {
  readonly registrar: LinkRegistrar;
  readonly quoter: RebateQuoter;

  constructor(registrar: LinkRegistrar, quoter: RebateQuoter) {
    this.registrar = registrar;
    this.quoter = quoter;
  }
}

let app: HttpApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
});

it('[AC-B1-05j#18] AppModule 向 catalog 提供真实 LinkRegistrar 和 RebateQuoter，登记委托 linking', async () => {
  const f = fixture();
  const demoQuoter = vi.spyOn(catalogPublic, 'createDemoRebateQuoter');
  const contexts: RegistrationContext[] = [];
  const linking = LinkingModule.forRoot;
  vi.spyOn(LinkingModule, 'forRoot').mockImplementationOnce((config) => {
    const module = linking(config);
    return {
      ...module,
      providers: (module.providers ?? []).map((provider) =>
        typeof provider === 'object' && provider.provide === LINK_REGISTRATIONS
          ? {
              provide: LINK_REGISTRATIONS,
              useValue: {
                forContext(context: RegistrationContext) {
                  contexts.push(context);
                  return { register: f.register, entrySource: async () => null };
                },
              },
            }
          : provider,
      ),
    };
  });
  const catalog = CatalogModule.forRoot;
  vi.spyOn(CatalogModule, 'forRoot').mockImplementationOnce((config) => {
    const module = catalog(config);
    return {
      ...module,
      providers: [
        ...(module.providers ?? []),
        {
          provide: SearchPorts,
          inject: [LinkRegistrar, RebateQuoter],
          useFactory: (registrar: LinkRegistrar, quoter: RebateQuoter) =>
            new SearchPorts(registrar, quoter),
        },
      ],
      exports: [...(module.exports ?? []), SearchPorts],
    };
  });
  const result = await observed(async () => {
    app = await createApp(f.clock);
    await app.init();
    return app.resolve(SearchPorts);
  });
  expect(result).toMatchObject({ kind: 'returned' });
  if (result.kind !== 'returned') return;
  expect(result.value.quoter.quote).toEqual(expect.any(Function));
  expect(demoQuoter).toHaveBeenCalledWith(
    expect.objectContaining({
      appEnv: 'test',
      unionMode: expect.stringMatching(/^(demo|replay)$/u),
    }),
  );
  const product = candidate('registration');
  const input: RegisterLinkInput = {
    viewer: { appId: 'synthetic-app', userId: null, deviceId: null },
    ref: product.ref,
    item: product.item,
    quote: {
      rebateMinFen: 10n,
      rebateMaxFen: 20n,
      estNetPriceFen: null,
      rebateBasis: 'price_compare_risk',
    },
    entrySource: 'search',
  };
  const registered = await result.value.registrar.register(input);
  expect(registered).toEqual({ linkId: '00000000-0000-7000-8000-000000000001' });
  expect(f.register).toHaveBeenCalledExactlyOnceWith(input);
  expect(contexts).toHaveLength(1);
});
