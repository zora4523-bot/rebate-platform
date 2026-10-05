// In-process TOTP replay store: FOR TESTS ONLY. It protects only verifiers that share this one
// object inside one process; two runs of a seed script or command-line tool would each start
// with an empty store. Production code uses the durable store in ./totp-replay-pg.ts (the
// default of createSuperVerifier and of the Nest wiring).
//
// Pure module (no decorators, erasable syntax).
import type { Clock } from '../../platform/index.ts';
import {
  TOTP_WINDOW_STEPS,
  totpTimeStep,
  type TotpClaim,
  type TotpReplayStore,
} from '../domain/totp.ts';

export function createMemoryTotpReplayStore(deps: { clock: Clock }): TotpReplayStore {
  // key → claimed time step
  const claims = new Map<string, bigint>();
  return {
    consume(claim: TotpClaim): Promise<boolean> {
      // A claim can only be presented again while its step is inside the window; keep one
      // extra step of margin and forget anything older.
      const oldest = totpTimeStep(deps.clock.now()) - BigInt(TOTP_WINDOW_STEPS + 1);
      for (const [key, step] of claims) if (step < oldest) claims.delete(key);
      const key = JSON.stringify([claim.appId, claim.adminId, claim.timeStep.toString()]);
      if (claims.has(key)) return Promise.resolve(false);
      claims.set(key, claim.timeStep);
      return Promise.resolve(true);
    },
  };
}
