import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { createUnionFileReplay } from '../../../../apps/api/src/modules/union/index.ts';
import { instant, provenance, recording, request, workspace, writeRecording } from './kit.ts';

// Temporary framework-only synthetic content exercises source checks, not probe authenticity.
it('[AC-B1-04c-REPORT#6] 仅加载 probe 来源时满足报告的来源资格检查', async () => {
  await workspace(async (root) => {
    const scenario = 'synthetic-probe-only';
    const metadata = provenance('probe');
    const directory = await writeRecording(root, 'jd', scenario, metadata);
    const replay = createUnionFileReplay({ directory: root, clock: new FixedClock(instant) });

    expect(await replay.transport(request('jd', scenario))).toEqual(recording().response);
    expect(replay.report()).toEqual({
      recordings: [
        { platform: 'jd', scenario, directory, provenance: metadata, loadedAt: instant },
      ],
      acceptanceEligible: true,
    });
  });
});

it.each(['synthetic', 'doc-derived'] as const)(
  '[AC-B1-04c-REPORT#7] 先加载 probe 再加载 %s，报告必须失去验收来源资格',
  async (source) => {
    await workspace(async (root) => {
      const probeScenario = 'synthetic-probe-first';
      const otherScenario = `synthetic-${source}-second`;
      const probeMetadata = provenance('probe');
      const otherMetadata = provenance(source);
      const probeDirectory = await writeRecording(root, 'jd', probeScenario, probeMetadata);
      const otherDirectory = await writeRecording(root, 'jd', otherScenario, otherMetadata);
      const replay = createUnionFileReplay({ directory: root, clock: new FixedClock(instant) });

      await replay.transport(request('jd', probeScenario));
      expect(replay.report().acceptanceEligible).toBe(true);
      await replay.transport(request('jd', otherScenario));
      expect(replay.report()).toEqual({
        recordings: [
          {
            platform: 'jd',
            scenario: probeScenario,
            directory: probeDirectory,
            provenance: probeMetadata,
            loadedAt: instant,
          },
          {
            platform: 'jd',
            scenario: otherScenario,
            directory: otherDirectory,
            provenance: otherMetadata,
            loadedAt: instant,
          },
        ],
        acceptanceEligible: false,
      });
    });
  },
);

it.each(['synthetic', 'doc-derived'] as const)(
  '[AC-B1-04c-REPORT#8] 先加载 %s 再加载 probe，报告不得恢复验收来源资格',
  async (source) => {
    await workspace(async (root) => {
      const otherScenario = `synthetic-${source}-first`;
      const probeScenario = 'synthetic-probe-second';
      const otherMetadata = provenance(source);
      const probeMetadata = provenance('probe');
      const otherDirectory = await writeRecording(root, 'jd', otherScenario, otherMetadata);
      const probeDirectory = await writeRecording(root, 'jd', probeScenario, probeMetadata);
      const replay = createUnionFileReplay({ directory: root, clock: new FixedClock(instant) });

      await replay.transport(request('jd', otherScenario));
      expect(replay.report().acceptanceEligible).toBe(false);
      await replay.transport(request('jd', probeScenario));
      expect(replay.report()).toEqual({
        recordings: [
          {
            platform: 'jd',
            scenario: otherScenario,
            directory: otherDirectory,
            provenance: otherMetadata,
            loadedAt: instant,
          },
          {
            platform: 'jd',
            scenario: probeScenario,
            directory: probeDirectory,
            provenance: probeMetadata,
            loadedAt: instant,
          },
        ],
        acceptanceEligible: false,
      });
    });
  },
);
