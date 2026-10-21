import { beforeAll, expect, it } from 'vitest';
import type * as Guard from '../../../../apps/api/src/modules/identity/application/deletion-guard.ts';
import { identity } from './kit.ts';

let api: typeof Guard;
beforeAll(async () => {
  api = await identity();
});

it('[AC-B1-15e#1] 无注销阶段（含只有已撤回的单）→ 放行', () => {
  expect(api.deletionStageRefusal('none')).toBeNull();
});

it('[AC-B1-15e#1] 冷静期 → 10007 stage=cooling', () => {
  expect(api.deletionStageRefusal('cooling')).toEqual({ code: 10007, stage: 'cooling' });
});

for (const stage of ['processing', 'done'] as const) {
  it(`[AC-B1-15e#1] ${stage} → 10007 stage=processing（契约 stage 只有 cooling / processing）`, () => {
    expect(api.deletionStageRefusal(stage)).toEqual({ code: 10007, stage: 'processing' });
  });
}
