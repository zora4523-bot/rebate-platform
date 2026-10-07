import type { AuthProvider } from '@refinedev/core';
import type { Schema } from '@couli/contracts-ts';

export type AdminIdentity = Schema<'AdminMe'>;
export type AdminSession = Schema<'AdminSession'>;
export type AdminBindingSecret = Schema<'AdminTotpSecretData'>;
export type AdminLoginStepData = Schema<'AdminLoginStepData'>;

export interface AuthClock {
  now(): number;
}

export interface AuthOptions {
  readonly api: { readonly baseUrl: string; readonly fetch: typeof globalThis.fetch };
  /** Default: sessionStorage, with memory fallback. Never localStorage. */
  readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  readonly clock?: AuthClock;
}

export type LoginInput =
  | { readonly step: 'credentials'; readonly username: string; readonly password: string }
  | { readonly step: 'change_password'; readonly newPassword: string }
  | { readonly step: 'totp' | 'bind_totp'; readonly code: string };

export interface LoginSnapshot {
  readonly step: 'credentials' | 'change_password' | 'totp' | 'bind_totp' | 'done';
  readonly username: string;
  readonly secret?: Schema<'AdminTotpSecretData'>;
  readonly error?: {
    readonly key: string;
    readonly lockedUntil?: string;
    readonly retryAfterSeconds?: number;
  };
}

export interface AdminAuthProvider extends AuthProvider {
  login(input: LoginInput): ReturnType<AuthProvider['login']>;
  getIdentity(): Promise<Schema<'AdminMe'> | null>;
  getSnapshot(): LoginSnapshot;
  subscribe(listener: () => void): () => void;
  getToken(): string | null;
  /** Called only after a successful authenticated request, never on input or failed requests. */
  recordSuccessfulRequest(): void;
  /** Discard the pending login ticket and binding secret when leaving or switching account. */
  resetLogin(): void;
  dispose(): void;
}

export function createAuthProvider(options: AuthOptions): AdminAuthProvider {
  void options;
  throw new Error('NotImplemented: createAuthProvider');
}
