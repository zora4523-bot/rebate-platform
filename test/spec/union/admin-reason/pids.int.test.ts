// B1-22r / orchestrator ruling D10-427 ①, SPEC_REF 37808a5: the optional reason of the union-pids
// writes (create / update / activate / retire; activate carries it as a multipart field) with a
// Unicode Cc control character is 20001 with data.fields=[reason]: the PID rows, the accounts and
// the audit stay as they were, and activate stores no screenshot. A reason without one is
// unaffected. Real admin HTTP (Fastify inject) + business-role PG through the B1-22h kit; only the
// screenshot store's put is replaced (as evidence-upload.int.test.ts) to count its calls.
import { afterEach, expect, it, vi } from 'vitest';
import { HjyIgnoreEvidenceStore } from '../../../../apps/api/src/modules/union/infra/hjy-ignore-evidence-store.ts';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  WRITES,
  accepted,
  bodyFor,
  rejected,
  seedPid,
  setup,
  snapshot,
  type Action,
  type Scenario,
} from '../admin-pids/kit.ts';
import { NAMED_CONTROLS, VALID_REASONS, controlReasons, shown } from './kit.ts';

const h = useHarness();
afterEach(() => vi.restoreAllMocks());

function captureStorage() {
  return vi.spyOn(HjyIgnoreEvidenceStore.prototype, 'put').mockResolvedValue(undefined);
}

/** A row the action accepts: retire needs an active row, the others a pending one. */
const rowFor = (s: Scenario, action: Action) =>
  seedPid(s, { status: action === 'retire' ? 'active' : 'pending' });

for (const action of WRITES) {
  it(`[B1-22r][D10-427 ①] ${action}：reason 含 \\n \\t \\u0000 \\u007f → 20001 [reason]，推广位、账号与审计不变，不存截图`, async () => {
    const put = captureStorage();
    const s = await setup(h);
    const row = await rowFor(s, action);
    const before = await snapshot(s);
    for (const reason of controlReasons()) {
      await rejected(await s.write(action, row.id, { ...bodyFor(action, row), reason }), 20001, {
        fields: ['reason'],
      });
      expect(await snapshot(s), shown(reason)).toEqual(before);
    }
    expect(put).not.toHaveBeenCalled();
  });

  it(`[B1-22r][D10-427 ①] ${action}：控制字符被拒之后，合法 reason（200 字、中文、空格）照常成功并记入审计`, async () => {
    captureStorage();
    const s = await setup(h);
    for (const control of NAMED_CONTROLS) {
      const row = await rowFor(s, action);
      const before = await snapshot(s);
      await rejected(
        await s.write(action, row.id, { ...bodyFor(action, row), reason: `原因${control}` }),
        20001,
        { fields: ['reason'] },
      );
      expect(await snapshot(s), shown(control)).toEqual(before);
    }
    const ids: string[] = [];
    for (const reason of VALID_REASONS) {
      const row = await rowFor(s, action);
      const data = await accepted(
        await s.write(action, row.id, { ...bodyFor(action, row), reason }),
      );
      expect(data.pid_id, shown(reason)).toEqual(expect.any(String));
      ids.push(data.pid_id);
    }
    const rows = (await s.audits()).filter((entry) => entry.action === `union_pid_${action}`);
    expect(rows).toHaveLength(VALID_REASONS.length);
    for (const [index, reason] of VALID_REASONS.entries()) {
      expect(rows[index]).toMatchObject({ app_id: s.appId, admin_id: s.a.id });
      expect(rows[index]!.target, shown(reason)).toContain(ids[index]);
      expect(rows[index]!.after, shown(reason)).toMatchObject({ reason });
    }
  });
}
