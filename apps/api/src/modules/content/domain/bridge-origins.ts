import type { KeyObject } from 'node:crypto';

export interface BridgeOriginsInput {
  readonly appId: string;
  readonly env: 'local' | 'test' | 'staging' | 'prod';
  readonly h5BaseUrl: string;
  readonly item: { readonly version: number; readonly value: unknown } | null;
}

export interface BridgeOriginsKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
}

export class BridgeOriginsSigner {
  constructor(key: BridgeOriginsKey) {
    void key;
    throw new Error('NotImplemented: BridgeOriginsSigner');
  }

  sign(input: BridgeOriginsInput): { jws: string } {
    void input;
    throw new Error('NotImplemented: BridgeOriginsSigner.sign');
  }
}
