import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createUnionFileReplay,
  parseUnionRecordingProvenance,
} from '../../../../apps/api/src/modules/union/index.ts';
import {
  instant,
  platforms,
  provenance,
  recording,
  repository,
  request,
  scenario,
  workspace,
  writeRecording,
} from './kit.ts';

it('[AC-B1-04c-REPORT#1] 空回放不能作为验收通过的依据', async () => {
  await workspace(async (root) => {
    const replay = createUnionFileReplay({ directory: root, clock: new FixedClock(instant) });
    expect(replay.report()).toEqual({ recordings: [], acceptanceEligible: false });
  });
});

it.each(['synthetic', 'doc-derived'] as const)(
  '[AC-B1-04c-REPORT#2] %s 可供技术回放，但报告必须保留来源且禁止作为验收通过依据',
  async (source) => {
    await workspace(async (root) => {
      const replay = createUnionFileReplay({ directory: root, clock: new FixedClock(instant) });
      const metadata = provenance(source);
      const directory = await writeRecording(root, 'jd', scenario, metadata);
      expect(await replay.transport(request())).toEqual(recording().response);
      expect(replay.report()).toEqual({
        recordings: [
          { platform: 'jd', scenario, directory, provenance: metadata, loadedAt: instant },
        ],
        acceptanceEligible: false,
      });
    });
  },
);

it('[AC-B1-04c-REPORT#3] 本次加载清单按实例隔离，只记录已用录制，时刻来自注入 Clock', async () => {
  await workspace(async (root) => {
    const clock = new FixedClock(instant);
    const replay = createUnionFileReplay({ directory: root, clock });
    const separate = createUnionFileReplay({ directory: root, clock });
    await writeRecording(root);
    const later = '2031-02-03T04:05:07.789Z';
    await writeRecording(root, 'pdd', 'synthetic-next');
    await writeRecording(root, 'taobao', 'synthetic-unused');
    await replay.transport(request());
    const snapshot = replay.report();
    clock.set(later);
    await replay.transport({
      ...request('pdd', 'synthetic-next'),
      headers: { 'X-Scenario': 'synthetic-next', 'X-Clock': '2099-01-01T00:00:00.000Z' },
    });
    expect(replay.report().recordings).toEqual([
      {
        platform: 'jd',
        scenario,
        directory: join(root, 'jd', scenario),
        provenance: provenance(),
        loadedAt: instant,
      },
      {
        platform: 'pdd',
        scenario: 'synthetic-next',
        directory: join(root, 'pdd', 'synthetic-next'),
        provenance: provenance(),
        loadedAt: later,
      },
    ]);
    expect(snapshot.recordings).toHaveLength(1);
    expect(separate.report()).toEqual({ recordings: [], acceptanceEligible: false });
    expect(replay.report().acceptanceEligible).toBe(false);
  });
});

it('[AC-B1-04c-REPORT#4] 并发不同平台与场景的结果、来源和加载记录不串线', async () => {
  await workspace(async (root) => {
    const replay = createUnionFileReplay({ directory: root, clock: new FixedClock(instant) });
    for (const platform of platforms) {
      await writeRecording(
        root,
        platform,
        `synthetic-${platform}`,
        provenance(),
        recording(`synthetic-${platform}`),
      );
    }
    const responses = await Promise.all(
      platforms.map((platform) => replay.transport(request(platform, `synthetic-${platform}`))),
    );
    expect(responses).toEqual(
      platforms.map((platform) => recording(`synthetic-${platform}`).response),
    );
    const report = replay.report();
    expect(report.recordings).toHaveLength(3);
    expect(report.recordings).toEqual(
      expect.arrayContaining(
        platforms.map((platform) => ({
          platform,
          scenario: `synthetic-${platform}`,
          directory: join(root, platform, `synthetic-${platform}`),
          provenance: provenance(),
          loadedAt: instant,
        })),
      ),
    );
    expect(report.acceptanceEligible).toBe(false);
  });
});

it.each(platforms)(
  '[AC-B1-04c-REPORT#5] 仓库 %s 样例按目录约定存放且全部明确标为 synthetic',
  async (platform) => {
    const root = join(repository, 'fixtures', 'union-recordings');
    const replay = createUnionFileReplay({ directory: root, clock: new FixedClock(instant) });
    const scenarios = await readdir(join(root, platform)).catch(() => [] as string[]);
    expect(scenarios).toContain(scenario);
    for (const sample of scenarios) {
      const directory = join(root, platform, sample);
      const metadata: unknown = JSON.parse(
        await readFile(join(directory, 'provenance.json'), 'utf8'),
      );
      expect(parseUnionRecordingProvenance(metadata)).toMatchObject({
        source: 'synthetic',
        probeRunId: null,
      });
      const envelope = JSON.parse(
        await readFile(join(directory, 'recording.json'), 'utf8'),
      ) as ReturnType<typeof recording>;
      // These samples describe framework bytes, not invented platform JSON fields.
      expect(envelope.request.body).toMatch(/^synthetic-/);
      expect(envelope.response.body).toMatch(/^synthetic-/);
      expect(
        await replay.transport({
          platform,
          method: envelope.request.method as 'POST',
          url: `https://synthetic.invalid${envelope.request.path}`,
          body: envelope.request.body,
          headers: { 'X-Scenario': sample },
        }),
      ).toEqual(envelope.response);
    }
    expect(replay.report().acceptanceEligible).toBe(false);
  },
);
