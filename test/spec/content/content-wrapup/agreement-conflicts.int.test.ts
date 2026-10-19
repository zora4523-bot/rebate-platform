// F1-02z §9.2#1 / §9.3#1–2. Each case includes a conflict witness so it is red before L44 is fixed.
import { expect, it } from 'vitest';
import {
  config,
  input,
  publish,
  rejected,
  setup,
  snapshot,
  stepUp,
  success,
  useHarness,
  type Version,
} from './kit.ts';

const h = useHarness(() => import('@couli/db/testing'));

for (const type of ['privacy', 'agreement'] as const) {
  for (const value of [1, 5]) {
    it(`[AC-F1-02z#1] ${type} 已有版本 ${value}：20902、五表不变、仅 warn；非整数与零仍可首发`, async () => {
      // Controls share the regression test, rather than becoming already-green new tests.
      for (const allowed of value === 1 ? [0, '3'] : [1.5]) {
        const normal = await setup(h);
        await config(h, normal.appId, `legal.${type}.version`, allowed);
        const token = await stepUp(normal);
        const result = await success<Version>(
          await publish(normal, type, input(), token),
          'publish',
        );
        expect(result).toMatchObject({ type, version: 1 });
        const state = await snapshot(h, normal.appId);
        expect(state.items.find((row) => row.key === `legal.${type}.version`)).toMatchObject({
          value: 1,
        });
      }

      // The H5 configuration check must still precede L44 (50001 even when legal is ahead).
      const missingH5 = await setup(h, { h5: false });
      await config(h, missingH5.appId, `legal.${type}.version`, value);
      const missingStep = await stepUp(missingH5);
      const missingBefore = await snapshot(h, missingH5.appId);
      await rejected(await publish(missingH5, type, input(), missingStep), 'publish', 50001);
      expect(await snapshot(h, missingH5.appId)).toEqual(missingBefore);

      const f = await setup(h);
      const key = `legal.${type}.version`;
      await config(h, f.appId, key, value);
      const token = await stepUp(f);
      const before = await snapshot(h, f.appId);
      const logStart = f.lines.length;
      const sent = await publish(f, type, input(), token);
      await rejected(sent, 'publish', 20902, { resource: 'agreement' });
      expect(await snapshot(h, f.appId)).toEqual(before);
      // Only this request's time window; setup and the H5 control use separate log sinks.
      const logs = f.lines.slice(logStart).map(
        (line) =>
          JSON.parse(line) as {
            level: number;
            msg?: string;
          },
      );
      expect(logs.filter((line) => line.level === 50)).toEqual([]);
      expect(logs.filter((line) => line.level === 40)).toEqual([
        expect.objectContaining({
          msg: 'agreement_publish_legal_version_ahead',
          app_id: f.appId,
          agreement_type: type,
          key,
          config_value: value,
          version: 1,
        }),
      ]);
    });
  }
}
