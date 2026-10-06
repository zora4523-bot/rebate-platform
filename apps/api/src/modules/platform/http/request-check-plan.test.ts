// How bootstrap installs the entry's request check plan (REQUEST_CHECKS, app.module): an entry whose
// plan has no request signature check (stream and admin today) refuses to register a contract
// x-signed route, so it cannot start serving one unchecked (BR-ID-09 ①); an entry whose plan has
// no token check refuses a contract route that takes a token (BR-ID-01 ②), and a token check placed
// before the signature check keeps the entry from starting; and an error while the plan is
// installed closes the application it already created.
import { Controller, Post } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { AppModule } from '../../../app.module.ts';
import { createHttpApp } from '../../../bootstrap.ts';
import { FixedClock, createRootLogger, loadConfig, type HttpEntry } from '../index.ts';
import { contractSigningRoutes, isContractSignedRoute } from '../validation/signing-routes.ts';
import { contractAuthRoutes } from './auth-routes.ts';
import { REQUEST_CHECKS, type RequestCheckPlan } from './request-checks.ts';

let app: NestFastifyApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
});

function overrides(entry: HttpEntry) {
  return {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock('2026-10-06T04:00:00Z'),
    logger: createRootLogger({ level: 'silent', entry, appEnv: 'test' }),
  };
}

const SIGNED = contractSigningRoutes().find((route) => route.method === 'POST' && route.signed);
const UNSIGNED = contractSigningRoutes().find((route) => route.method === 'POST' && !route.signed);
/** An unsigned /v1 contract route by x-auth (not /healthz, which the health module registers). */
const unsignedWith = (auth: string) =>
  contractAuthRoutes().find(
    (route) =>
      route.auth === auth &&
      route.path.startsWith('/v1/') &&
      !isContractSignedRoute(route.method, route.path),
  );

/** A Nest route on a signed contract template (test only). */
@Controller('v1/auth')
class SignedProbeController {
  @Post('sms-codes')
  send() {
    return { reached: true };
  }
}

/** A Nest route on an unsigned x-auth login contract template (test only). */
@Controller('v1/auth')
class LoginProbeController {
  @Post('logout')
  logout() {
    return { reached: true };
  }
}

for (const entry of ['stream', 'admin'] as const) {
  it(`[BR-ID-01] the ${entry} entry has no token check and refuses a contract route that takes a token at registration`, async () => {
    const login = unsignedWith('login');
    const optional = unsignedWith('optional');
    const none = unsignedWith('none');
    expect([login, optional, none].every((route) => route !== undefined)).toBe(true);
    app = await createHttpApp(entry, overrides(entry));
    const server = app.getHttpAdapter().getInstance();
    for (const route of [login!, optional!]) {
      expect(() =>
        server.route({ method: route.method, url: route.path, handler: () => ({}) }),
      ).toThrow(
        `the ${entry} entry does not run the token check (BR-ID-01 ②) on this contract route that takes a token: ${route.method} ${route.path}`,
      );
    }
    // x-auth none and a route outside the contract register as before; the entry starts.
    expect(() =>
      server.route({ method: none!.method, url: none!.path, handler: () => ({ reached: true }) }),
    ).not.toThrow();
    expect(() => server.get('/__plan_probe', () => ({ reached: true }))).not.toThrow();
    await app.init();
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });
}

it('[BR-ID-01] a Nest controller on a login template keeps the stream entry from starting', async () => {
  const original = AppModule.forEntry;
  vi.spyOn(AppModule, 'forEntry').mockImplementationOnce((options) => ({
    ...original(options),
    controllers: [LoginProbeController],
  }));
  app = await createHttpApp('stream', overrides('stream'));
  await expect(app.init()).rejects.toThrow(
    'the stream entry does not run the token check (BR-ID-01 ②) on this contract route that takes a token: POST /v1/auth/logout',
  );
});

it('[BR-ID-01] an api plan running the token check before the signature check keeps the entry from starting', async () => {
  const original = AppModule.forEntry;
  vi.spyOn(AppModule, 'forEntry').mockImplementationOnce((options) => {
    const root = original(options);
    const providers = (root.providers ?? []).map((provider) => {
      if (typeof provider !== 'object' || !('provide' in provider)) return provider;
      if (provider.provide !== REQUEST_CHECKS || !('useFactory' in provider)) return provider;
      const factory = provider.useFactory as (...values: unknown[]) => RequestCheckPlan;
      return {
        ...provider,
        useFactory: (...values: unknown[]): RequestCheckPlan => {
          const plan = factory(...values);
          return { ...plan, checks: [...plan.checks].reverse() };
        },
      };
    });
    return { ...root, providers };
  });
  await expect(createHttpApp('api', overrides('api'))).rejects.toThrow(
    "the api entry's request check plan must run the token check (BR-ID-01 ②) after the request signature check (BR-ID-01 ①)",
  );
});

for (const entry of ['stream', 'admin'] as const) {
  it(`[BR-ID-09] the ${entry} entry has no signature check and refuses a contract x-signed route at registration`, async () => {
    expect(SIGNED).toBeDefined();
    expect(UNSIGNED).toBeDefined();
    app = await createHttpApp(entry, overrides(entry));
    const server = app.getHttpAdapter().getInstance();
    expect(() => server.post(SIGNED!.path, () => ({ reached: true }))).toThrow(
      `the ${entry} entry does not run the request signature check (BR-ID-09 ①) on this contract x-signed route: POST ${SIGNED!.path}`,
    );
    // An unsigned contract route and a route outside the contract register as before.
    expect(() => server.post(UNSIGNED!.path, () => ({ reached: true }))).not.toThrow();
    expect(() => server.post('/__plan_probe', () => ({ reached: true }))).not.toThrow();
    await app.init();
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });
}

it('[BR-ID-09] a Nest controller on a signed template keeps the admin entry from starting', async () => {
  const original = AppModule.forEntry;
  vi.spyOn(AppModule, 'forEntry').mockImplementationOnce((options) => ({
    ...original(options),
    controllers: [SignedProbeController],
  }));
  app = await createHttpApp('admin', overrides('admin'));
  await expect(app.init()).rejects.toThrow(
    'the admin entry does not run the request signature check (BR-ID-09 ①) on this contract x-signed route: POST /v1/auth/sms-codes',
  );
});

it('[BR-ID-09] the api entry, whose plan runs the signature check on every x-signed route, registers them', async () => {
  expect(SIGNED).toBeDefined();
  app = await createHttpApp('api', overrides('api'));
  const server = app.getHttpAdapter().getInstance();
  // Nest registers the implemented operations in init (which would refuse an unchecked signed
  // route); a probe then registers every other signed route, before the server is ready.
  await app.init();
  let probed = 0;
  for (const route of contractSigningRoutes().filter((candidate) => candidate.signed)) {
    if (server.hasRoute({ method: route.method, url: route.path })) continue;
    expect(() =>
      server.route({ method: route.method, url: route.path, handler: () => ({}) }),
    ).not.toThrow();
    probed += 1;
  }
  expect(probed).toBeGreaterThan(0);
  await server.ready();
  for (const route of contractSigningRoutes().filter((candidate) => candidate.signed)) {
    expect(server.hasRoute({ method: route.method, url: route.path })).toBe(true);
  }
});

it('[BR-ID-09] an api plan that would leave an x-signed route unbuffered keeps the entry from starting', async () => {
  expect(SIGNED).toBeDefined();
  const original = AppModule.forEntry;
  vi.spyOn(AppModule, 'forEntry').mockImplementationOnce((options) => {
    const root = original(options);
    // The real plan (with the signature check), but buffered on no route.
    const providers = (root.providers ?? []).map((provider) => {
      if (typeof provider !== 'object' || !('provide' in provider)) return provider;
      if (provider.provide !== REQUEST_CHECKS || !('useFactory' in provider)) return provider;
      const factory = provider.useFactory as (...values: unknown[]) => RequestCheckPlan;
      return {
        ...provider,
        useFactory: (...values: unknown[]): RequestCheckPlan => ({
          ...factory(...values),
          bufferWhen: () => false,
        }),
      };
    });
    return { ...root, providers };
  });
  app = await createHttpApp('api', overrides('api'));
  expect(() =>
    app!
      .getHttpAdapter()
      .getInstance()
      .post(SIGNED!.path, () => ({})),
  ).toThrow(
    `the api entry does not run the request signature check (BR-ID-09 ①) on this contract x-signed route: POST ${SIGNED!.path}`,
  );
});

it('[B1-03b] an error while installing the plan closes the application created before it', async () => {
  const shutdown = vi.fn(async () => undefined);
  const original = AppModule.forEntry;
  vi.spyOn(AppModule, 'forEntry').mockImplementationOnce((options) => ({
    ...original(options),
    providers: [
      { provide: REQUEST_CHECKS, useValue: { checks: ['not a check'] } },
      { provide: 'SHUTDOWN_PROBE', useValue: { onApplicationShutdown: shutdown } },
    ],
  }));
  await expect(createHttpApp('stream', overrides('stream'))).rejects.toThrow(
    'every request check must be a function',
  );
  expect(shutdown).toHaveBeenCalledTimes(1);
});
