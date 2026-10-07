import type { AppEnv } from '../../platform/index.ts';
import type { LinkConversionOptions } from './link-open-conversion.ts';
import type { LinkOpenRequoteInput, LinkOpenRequoteOptions } from './link-open-requote.ts';
import type { LinkOpenService } from './link-open.ts';

/** Read from contracts/apps.json by the composition root; no platform scheme literals here. */
export interface LinkOpenApps {
  readonly apps: Readonly<
    Record<
      'jd' | 'pdd',
      {
        readonly status: string;
        readonly ios: { readonly query_schemes: readonly string[] };
        readonly android: { readonly packages: readonly string[] };
        readonly harmony: { readonly query_schemes: readonly string[] };
      }
    >
  >;
}

/** Verification is per platform, client and path; omitted entries are unverified. */
export interface LinkOpenEnvironment {
  readonly appEnv: AppEnv;
  readonly apps: LinkOpenApps;
  readonly verifiedPaths: Readonly<
    Partial<
      Record<
        'jd' | 'pdd',
        Readonly<
          Partial<
            Record<LinkOpenRequoteInput['client'], readonly ('scheme' | 'universal_link' | 'h5')[]>
          >
        >
      >
    >
  >;
}

export type WiredLinkOpenOptions = Omit<LinkOpenRequoteOptions, 'conversion'> &
  LinkConversionOptions & { readonly environment: LinkOpenEnvironment };

/** AppModule's open entry, including admission of fresh, cached and fallback jump paths. */
export function createWiredLinkOpen(options: WiredLinkOpenOptions): LinkOpenService {
  void options;
  throw new Error('NotImplemented: createWiredLinkOpen');
}
