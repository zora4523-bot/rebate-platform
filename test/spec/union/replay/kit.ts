import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type {
  RegisteredPlatform,
  UnionRecordingProvenance,
  UnionTransportRequest,
} from '../../../../apps/api/src/modules/union/index.ts';

export const platforms = ['jd', 'pdd', 'taobao'] as const;
export const instant = '2031-02-03T04:05:06.789Z';
export const scenario = 'synthetic-smoke';
export const repository = fileURLToPath(new URL('../../../../', import.meta.url));

// Framework-only opaque content; it deliberately models no platform API response.
export function recording(label = 'synthetic-response') {
  return {
    request: {
      method: 'POST',
      path: '/synthetic-api/echo?case=synthetic',
      body: 'synthetic-input',
    },
    response: {
      status: 202,
      headers: { 'content-type': 'text/plain', 'x-synthetic-label': label },
      body: `${label}\n合成内容`,
    },
  };
}

export function provenance(
  source: UnionRecordingProvenance['source'] = 'synthetic',
): UnionRecordingProvenance {
  return {
    source,
    capabilityId: 'CAP-SYNTHETIC',
    probeRunId: source === 'probe' ? 'synthetic-validation-run' : null,
    capturedAt: '2030-01-02T03:04:05.000Z',
    originalSha256: createHash('sha256').update('synthetic-original').digest('hex'),
    sanitizerVersion: 'synthetic-sanitizer-v1',
  };
}

export function request(
  platform: RegisteredPlatform = 'jd',
  selectedScenario = scenario,
): UnionTransportRequest {
  return {
    platform,
    url: 'https://synthetic.invalid/synthetic-api/echo?case=synthetic',
    method: 'POST',
    headers: { 'X-Scenario': selectedScenario },
    body: 'synthetic-input',
  };
}

export async function writeRecording(
  root: string,
  platform: RegisteredPlatform = 'jd',
  selectedScenario = scenario,
  metadata: unknown = provenance(),
  envelope: unknown = recording(),
): Promise<string> {
  const directory = join(root, platform, selectedScenario);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'provenance.json'), JSON.stringify(metadata));
  await writeFile(join(directory, 'recording.json'), JSON.stringify(envelope));
  return directory;
}

export async function workspace(run: (directory: string) => Promise<void>): Promise<void> {
  const parent = join(repository, '.tmp', 'union-replay');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'case-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
