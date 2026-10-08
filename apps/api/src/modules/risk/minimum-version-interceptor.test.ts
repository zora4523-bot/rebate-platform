// Stage ④a fail-closed wiring of RiskModule (B1-03c §11.2): an idempotent operation's handler that
// finishes without the IDEMPOTENCY instance receiving the request answers 50001, never an
// unjudged response; a request the instance received (hook ran, or replay / 40901) passes.
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, from, type Observable } from 'rxjs';
import { expect, it } from 'vitest';
import {
  MINIMUM_VERSION_SCOPE,
  MinimumVersionUnjudgedError,
  createMinimumVersionEntryObserver,
  type MinimumVersionRequest,
} from './application/minimum-version.ts';
import { MINIMUM_VERSION_INTERCEPTOR } from './risk.module.ts';

function http(url: string): ExecutionContext {
  const request: MinimumVersionRequest = {
    id: 'trace-1',
    method: 'POST',
    headers: {},
    routeOptions: { url },
  };
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/** A route handler that optionally hands the request to the idempotency instance first. */
function handler(reachesIdempotency: boolean): CallHandler {
  const observer = createMinimumVersionEntryObserver();
  return {
    handle: () =>
      from(
        (async () => {
          await Promise.resolve();
          if (reachesIdempotency) observer({} as never);
          return { code: 0 };
        })(),
      ),
  };
}

const run = (context: ExecutionContext, next: CallHandler) =>
  firstValueFrom(MINIMUM_VERSION_INTERCEPTOR.intercept(context, next) as Observable<unknown>);

it('[BR-ID-01] an idempotent operation whose handler never reached the idempotency instance fails closed', async () => {
  await expect(run(http('/v1/links/:link_id/open'), handler(false))).rejects.toBeInstanceOf(
    MinimumVersionUnjudgedError,
  );
});

it('[BR-ID-01] an idempotent operation the idempotency instance received passes unchanged', async () => {
  await expect(run(http('/v1/links/:link_id/open'), handler(true))).resolves.toEqual({ code: 0 });
});

it('[BR-ID-01] a non-idempotent operation (judged by the guard) is not held to the idempotency entry', async () => {
  await expect(run(http('/v1/consents'), handler(false))).resolves.toEqual({ code: 0 });
});

it('[BR-ID-01] the entry observer outside an HTTP request scope marks nothing', () => {
  expect(MINIMUM_VERSION_SCOPE.getStore()).toBeUndefined();
  expect(() => createMinimumVersionEntryObserver()({} as never)).not.toThrow();
});
