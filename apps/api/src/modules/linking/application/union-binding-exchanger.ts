export interface UnionBindingExchangeInput {
  readonly appId: string;
  readonly method: 'web_code' | 'sdk_token';
  readonly credential:
    | { readonly code: string }
    | { readonly access_token: string; readonly expires_in: number };
  readonly appRef: string;
  readonly traceId: string;
}

export type UnionBindingExchangeResult =
  | { readonly kind: 'bound'; readonly relationId: string }
  | { readonly kind: 'credential_invalid' };

/** Injectable boundary for the demo credential exchange; no upstream call in rule tests. */
export class UnionBindingExchanger {
  exchange(input: UnionBindingExchangeInput): Promise<UnionBindingExchangeResult> {
    void input;
    throw new Error('NotImplemented: UnionBindingExchanger.exchange');
  }
}
