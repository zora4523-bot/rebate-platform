// The fallback is exercised with a container double; never requires Docker inside verify.
// The mock endpoint is the SAME one-shot service supplied by the orchestrator, if readiness
// checks need a connection. TEST_REDIS_URL is restored after each test and never printed.
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';

const requireDb = createRequire(new URL('../../../../packages/db/package.json', import.meta.url));
const containersPath = requireDb.resolve('testcontainers');

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock(containersPath);
  vi.resetModules();
});

it.each([undefined, ''])(
  '[AC-B1-01y-FIXTURE#1] TEST_REDIS_URL=%j 时启动一次性 Redis 7，noeviction，停止容器',
  async (unset) => {
    // Without the CI service, first acquire a genuine throwaway container, never localhost's stack.
    let backing: { url: string; stop(): Promise<void> } | undefined;
    const supplied = process.env['TEST_REDIS_URL'];
    if (supplied === undefined || supplied === '') {
      const original = (await import(
        new URL('../../../../packages/db/src/testing/index.ts', import.meta.url).href
      )) as Record<string, unknown>;
      expect(typeof original['acquireTestRedis']).toBe('function');
      backing = await (
        original['acquireTestRedis'] as () => Promise<{ url: string; stop(): Promise<void> }>
      )();
    }
    try {
      const service = new URL(backing?.url ?? supplied!);
      const command: string[][] = [];
      const images: string[] = [];
      const ports: number[] = [];
      const stopped = vi.fn(async () => {});
      const started = vi.fn(async () => ({
        getHost: () => service.hostname,
        getMappedPort: () => Number(service.port || '6379'),
        stop: stopped,
      }));
      const builder = {
        withExposedPorts: (...values: number[]) => {
          ports.push(...values);
          return builder;
        },
        withCommand: (args: string[]) => {
          command.push(args);
          return builder;
        },
        withWaitStrategy: () => builder,
        withStartupTimeout: () => builder,
        withLabels: () => builder,
        withTmpFs: () => builder,
        withEnvironment: () => builder,
        start: started,
      };
      vi.doMock(containersPath, () => ({
        GenericContainer: class {
          constructor(image: string) {
            images.push(image);
            return builder;
          }
        },
        Wait: {
          forLogMessage: () => ({}),
          forListeningPorts: () => ({}),
        },
      }));
      vi.stubEnv('TEST_REDIS_URL', unset);
      vi.resetModules();
      const testing = (await import(
        new URL('../../../../packages/db/src/testing/index.ts', import.meta.url).href
      )) as Record<string, unknown>;
      expect(typeof testing['acquireTestRedis']).toBe('function');
      const server = await (
        testing['acquireTestRedis'] as () => Promise<{
          url: string;
          source: string;
          stop(): Promise<void>;
        }>
      )();
      try {
        expect(server.source).toBe('testcontainers');
        expect(images).toHaveLength(1);
        expect(images[0]).toMatch(/^redis:7(?:[.-]|$)/);
        expect(ports).toContain(6379);
        const argv = command.flat();
        expect(argv).toContain('--maxmemory-policy');
        expect(argv[argv.indexOf('--maxmemory-policy') + 1]).toBe('noeviction');
        expect(started).toHaveBeenCalledTimes(1);
        const url = new URL(server.url);
        expect(url.hostname === service.hostname).toBe(true);
        expect(url.port === service.port || (url.port === '' && service.port === '6379')).toBe(
          true,
        );
      } finally {
        await server.stop();
      }
      expect(stopped).toHaveBeenCalledTimes(1);
    } finally {
      await backing?.stop();
    }
  },
);
