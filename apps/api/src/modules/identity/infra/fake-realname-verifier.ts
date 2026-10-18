import type { RealnameVerifierPort } from '../ports/realname-verifier.ts';

/** The application assembly uses this factory. No configured vendor in staging / prod: null. */
export function createRealnameVerifier(appEnv: string): RealnameVerifierPort | null {
  void appEnv;
  throw new Error('NotImplemented: createRealnameVerifier');
}
