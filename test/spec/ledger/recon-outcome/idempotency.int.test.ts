// B2-09h idempotency rule tests (claude-independent, SPEC_REF 9ab94dc0): contracts/openapi.yaml
// closeAdminReconDiff (`Idempotency-Key`: same key and body → the first result; same key with
// another body → 20901; same key while still running → 40901; a new key for a closed difference →
// 20902). `outcome` is part of the body. Requests go through the real admin entry (kit.ts).
// Top-level it() only (规划/11 §4.3).
import { expect, it } from 'vitest';
import {
  CLOSE_ACTION,
  RECON,
  answer,
  audits,
  closed,
  conflict,
  diffNow,
  expectConcluded,
  fixture,
  holdRow,
  newKey,
  r1Diff,
  suite,
  track,
  waiting,
  withCloseAdmin,
} from './kit.ts';

const s = suite();

it('[AC-B2-09h#12] 同一 Idempotency-Key 同一请求体（含 outcome）重放：原样返回第一次的应答（recon_diff.resolution.outcome 在内），不再写审计；同 key 换 outcome 或去掉 outcome → 20901；新 key、别的账号同 key → 20902；结论始终是第一次的', async () => {
  const f = fixture(s);
  await withCloseAdmin(f, async (h) => {
    const diff = await r1Diff(f);
    const key = newKey();
    const body = { reason: '以联盟结算额为准', outcome: 'union' };
    const sent = await h.close(diff.id, body, { key });
    const data = await closed(sent);
    expect(data.recon_diff['resolution'], sent.body).toEqual(body);
    const after = await expectConcluded(f, diff, h.recon.id, body);
    const recorded = await audits(f);

    for (let i = 0; i < 2; i += 1) {
      const again = await h.close(diff.id, body, { key });
      expect(again.statusCode).toBe(sent.statusCode);
      expect(again.body).toBe(sent.body);
    }
    await answer(await h.close(diff.id, { ...body, outcome: 'ours' }, { key }), 20901);
    await answer(await h.close(diff.id, { reason: body.reason }, { key }), 20901);
    await conflict(await h.close(diff.id, { ...body, outcome: 'ours' }));
    const colleague = await h.caller([RECON]);
    await conflict(
      await h.close(diff.id, { ...body, outcome: 'ours' }, { key, caller: colleague }),
    );

    expect(await diffNow(f, diff.id)).toEqual(after);
    expect(await audits(f)).toEqual(recorded);
  });
});

it('[AC-B2-09h#13] 同一 key 的第一次还在执行时再发（同体、换 outcome）→ 40901；放行后第一次的 outcome 写入，之后重放得到它的应答，只有一条审计', async () => {
  const f = fixture(s);
  await withCloseAdmin(f, async (h) => {
    const diff = await r1Diff(f);
    const key = newKey();
    const body = { reason: '以联盟结算额为准', outcome: 'union' };
    const lock = await holdRow(f, 'recon_diffs', diff.id);
    const first = track(h.close(diff.id, body, { key }));
    try {
      expect(await waiting(f, 1, [first]), '第一次请求应在差错单行锁上等待').toBe(true);
      await answer(await h.close(diff.id, body, { key }), 40901);
      await answer(await h.close(diff.id, { ...body, outcome: 'ours' }, { key }), 40901);
      expect(await diffNow(f, diff.id)).toEqual(diff);
    } finally {
      await lock.release();
    }
    const sent = await first.promise;
    await closed(sent);
    await expectConcluded(f, diff, h.recon.id, body);
    const replay = await h.close(diff.id, body, { key });
    expect(replay.body).toBe(sent.body);
    expect(await audits(f, CLOSE_ACTION)).toHaveLength(1);
  });
});
