// [AC-B1-31#3] tracing configuration goes through loadConfig (apps/api AGENTS.md hard rule 6):
// OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is an optional http(s) URL, OTEL_TRACES_SAMPLER_ARG a ratio
// 0..1 (default 1); anything else refuses to start with a ConfigError naming the variable and never
// quoting the endpoint (it may carry credentials). Unit tests: no port is opened; the one enabled
// start points at a loopback port and records no span.
import { expect, it } from 'vitest';
import { ConfigError } from '../../../../apps/api/src/modules/platform/config/index.ts';
import { startTracing } from '../../../../apps/api/src/modules/platform/tracing/otel.ts';
import { ENDPOINT_VAR, SAMPLER_VAR, configOf, memoryLogger } from './kit.ts';

const VALID_ENDPOINT = 'http://127.0.0.1:9/insert/opentelemetry/v1/traces';

function failureOf(env: Record<string, string>): unknown {
  try {
    configOf(env);
  } catch (error) {
    return error;
  }
  return 'loadConfig accepted it';
}

it.each([
  ['ftp://b131-marker-ftp.example.test/v1/traces', 'b131-marker-ftp'],
  ['file:///b131-marker-file/v1/traces', 'b131-marker-file'],
  [
    'b131-marker-noscheme.example.test:10428/insert/opentelemetry/v1/traces',
    'b131-marker-noscheme',
  ],
  ['http//b131-marker-colon.example.test/v1/traces', 'b131-marker-colon'],
  ['//b131-marker-relative.example.test/v1/traces', 'b131-marker-relative'],
  ['not a url b131-marker-text', 'b131-marker-text'],
  ['http://', 'http://'],
  ['https://', 'https://'],
  ['javascript:b131-marker-js', 'b131-marker-js'],
] as const)(
  '[AC-B1-31#3] OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=%s is refused without quoting it',
  (value, marker) => {
    const failure = failureOf({ [ENDPOINT_VAR]: value });
    expect(failure).toBeInstanceOf(ConfigError);
    const error = failure as ConfigError;
    expect(error.problems.some((problem) => problem.startsWith(`${ENDPOINT_VAR}:`))).toBe(true);
    if (marker.startsWith('b131-')) {
      expect(error.problems.join('\n')).not.toContain(marker);
      expect(error.message).not.toContain(marker);
    }
  },
);

it('[AC-B1-31#3] an endpoint with credentials that is refused is not echoed either', () => {
  const failure = failureOf({ [ENDPOINT_VAR]: 'ftp://b131user:b131-marker-pass@example.test/x' });
  expect(failure).toBeInstanceOf(ConfigError);
  const error = failure as ConfigError;
  expect(error.problems.some((problem) => problem.startsWith(`${ENDPOINT_VAR}:`))).toBe(true);
  expect(error.message).not.toContain('b131-marker-pass');
  expect(error.message).not.toContain('b131user');
});

it.each(['-0.1', '-1', '1.01', '2', '100', 'abc', 'NaN', 'Infinity', '-Infinity', '0.5.1', '1/2'])(
  '[AC-B1-31#3] OTEL_TRACES_SAMPLER_ARG=%s (not a ratio 0..1) is refused',
  (value) => {
    const failure = failureOf({ [ENDPOINT_VAR]: VALID_ENDPOINT, [SAMPLER_VAR]: value });
    expect(failure).toBeInstanceOf(ConfigError);
    const error = failure as ConfigError;
    expect(error.problems.some((problem) => problem.startsWith(`${SAMPLER_VAR}:`))).toBe(true);
  },
);

it('[AC-B1-31#3] tracing problems are reported together with the other configuration problems', () => {
  const failure = failureOf({
    API_PORT: 'bad-port',
    [ENDPOINT_VAR]: 'ftp://b131-marker-merge.example.test/x',
    [SAMPLER_VAR]: '7',
  });
  expect(failure).toBeInstanceOf(ConfigError);
  const error = failure as ConfigError;
  expect(error.problems.some((problem) => problem.startsWith('API_PORT:'))).toBe(true);
  expect(error.problems.some((problem) => problem.startsWith(`${ENDPOINT_VAR}:`))).toBe(true);
  expect(error.problems.some((problem) => problem.startsWith(`${SAMPLER_VAR}:`))).toBe(true);
  expect(error.message).not.toContain('b131-marker-merge');
});

it('[AC-B1-31#3] http(s) endpoints and ratios 0..1 load, and such a configuration enables tracing on api', async () => {
  for (const endpoint of [
    VALID_ENDPOINT,
    'http://pigsty:10428/insert/opentelemetry/v1/traces',
    'https://traces.example.test/insert/opentelemetry/v1/traces',
    'HTTP://127.0.0.1:10428/insert/opentelemetry/v1/traces',
  ]) {
    expect(() => configOf({ [ENDPOINT_VAR]: endpoint })).not.toThrow();
  }
  for (const ratio of ['0', '1', '0.25', '0.5', '1.0', '0.0']) {
    expect(() => configOf({ [ENDPOINT_VAR]: VALID_ENDPOINT, [SAMPLER_VAR]: ratio })).not.toThrow();
  }
  const { logger } = memoryLogger('api');
  const handle = await startTracing({
    entry: 'api',
    config: configOf({ [ENDPOINT_VAR]: VALID_ENDPOINT, [SAMPLER_VAR]: '0.25' }),
    logger,
  });
  try {
    expect(handle.enabled).toBe(true);
  } finally {
    await handle.shutdown();
  }
});
