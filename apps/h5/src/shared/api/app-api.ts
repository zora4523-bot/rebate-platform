import type * as bridgeSdk from '@couli/bridge-sdk';
import type { ReactElement, ReactNode } from 'react';
import type { AppApiEnv } from '../env.ts';
import type { H5ApiClient } from './index.ts';

/** Injectable SDK facade; the default is @couli/bridge-sdk, never the native global. */
export type AppApiBridge = Pick<
  typeof bridgeSdk,
  'isInApp' | 'has' | 'call' | 'createH5TokenManager'
>;

export interface AppApiOptions {
  bridge?: AppApiBridge;
  fetch?: typeof globalThis.fetch;
  env?: AppApiEnv;
}

/** Missing bridge, app.getEnv capability, base URL or brand yields null. */
export function createAppApi(options?: AppApiOptions): H5ApiClient | null {
  void options;
  throw new Error('NotImplemented: createAppApi');
}

export interface ApiProviderProps {
  api: H5ApiClient | null;
  children?: ReactNode;
}

export function ApiProvider(props: ApiProviderProps): ReactElement {
  void props;
  throw new Error('NotImplemented: ApiProvider');
}

/** Returns null outside a provider or when the App API is unavailable. */
export function useApi(): H5ApiClient | null {
  throw new Error('NotImplemented: useApi');
}
