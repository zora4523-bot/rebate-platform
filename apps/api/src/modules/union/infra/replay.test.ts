import { describe, expect, it, vi } from 'vitest';
import type { UnionEndpoint } from '../domain/types.ts';
import {
  createUnionReplayClient,
  parseUnionRecordingProvenance,
  type UnionTransport,
} from './replay.ts';

const response = { status: 200, headers: {}, body: 'synthetic-response' };

function endpoints(baseUrl: string): readonly UnionEndpoint[] {
  return (['jd', 'pdd', 'taobao'] as const).map((platform) => ({
    platform,
    mode: 'replay',
    baseUrl,
    quotaKey: `synthetic:${platform}`,
  }));
}

const provenance = {
  source: 'synthetic',
  capabilityId: 'CAP-SYNTHETIC',
  probeRunId: null,
  capturedAt: '2030-01-02T03:04:05.000Z',
  originalSha256: '0'.repeat(64),
  sanitizerVersion: 'synthetic-none',
};

describe('union replay client', () => {
  it('[AC-B1-04c-UNIT#1] keeps the base path prefix when the base URL has no trailing slash', async () => {
    const transport = vi.fn<UnionTransport>().mockResolvedValue(response);
    const client = createUnionReplayClient({
      endpoints: endpoints('https://jd.synthetic.invalid/synthetic-api'),
      transport,
    });
    await client.send('jd', { method: 'GET', path: 'echo', scenario: 'synthetic-smoke' });
    expect(transport.mock.calls[0]![0].url).toBe('https://jd.synthetic.invalid/synthetic-api/echo');
  });

  it.each(['a/%2e%2e/%2e%2e/escape', 'a/%2fescape', 'mailto:x'])(
    '[AC-B1-04c-UNIT#2] refuses encoded escapes %s',
    async (path) => {
      const transport = vi.fn<UnionTransport>();
      const client = createUnionReplayClient({
        endpoints: endpoints('https://jd.synthetic.invalid/synthetic-api/'),
        transport,
      });
      await expect(
        client.send('jd', { method: 'GET', path, scenario: 'synthetic-smoke' }),
      ).rejects.toMatchObject({ code: 'invalid_replay_request' });
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it('[AC-B1-04c-UNIT#3] refuses an unsafe scenario before calling the transport', async () => {
    const transport = vi.fn<UnionTransport>();
    const client = createUnionReplayClient({
      endpoints: endpoints('https://jd.synthetic.invalid/'),
      transport,
    });
    await expect(
      client.send('jd', { method: 'GET', path: 'echo', scenario: '../synthetic' }),
    ).rejects.toMatchObject({ code: 'invalid_replay_request' });
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('union recording provenance', () => {
  it.each([
    { capturedAt: '2030-02-31T00:00:00.000Z' },
    { probeRunId: 'synthetic-run' },
    { extra: 'synthetic' },
    { originalSha256: 'A'.repeat(64) },
  ])('[AC-B1-04c-UNIT#4] rejects %j', (override) => {
    expect(() => parseUnionRecordingProvenance({ ...provenance, ...override })).toThrow(
      expect.objectContaining({ code: 'invalid_provenance' }),
    );
  });

  it('[AC-B1-04c-UNIT#5] accepts an offset instant and a leap day', () => {
    expect(
      parseUnionRecordingProvenance({ ...provenance, capturedAt: '2028-02-29T12:00:00+08:00' }),
    ).toMatchObject({ capturedAt: '2028-02-29T12:00:00+08:00' });
  });
});
