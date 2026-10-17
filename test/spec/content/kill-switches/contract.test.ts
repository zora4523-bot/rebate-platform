// F1-10d: the two operations leave `planned` (brief §9.2 #7: removed by the orchestrator's
// mechanical commit after the implementation) and keep the CT-02i auth, step-up and error codes.
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { apiRequire } from '../../admin/auth/kit.ts';

interface Operation {
  operationId: string;
  'x-auth'?: string;
  'x-implementation'?: string;
  'x-error-codes'?: number[];
  security?: unknown[];
  parameters?: { name: string; in: string; required?: boolean }[];
}

async function contract() {
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(
      path: string,
      options: object,
    ): Promise<{ paths: Record<string, Record<string, Operation>> }>;
  };
  return parser.dereference(
    fileURLToPath(new URL('../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
}

it.each([
  ['/admin/v1/kill-switches', 'get', 'adminListKillSwitches', [10001, 10403], false],
  [
    '/admin/v1/kill-switches/{key}',
    'put',
    'adminUpdateKillSwitch',
    [10001, 10003, 10403, 20001, 20902],
    true,
  ],
] as const)(
  '[AC-F1-10d#26] §9.2 #7 %s %s 去除 planned，保留 admin 鉴权、错误码与二次验证头（只在写操作上）',
  async (path, method, operationId, codes, stepUp) => {
    const doc = await contract();
    const operation = doc.paths[path]![method]!;
    expect(operation).toMatchObject({
      operationId,
      'x-auth': 'admin',
      security: [{ adminBearerAuth: [] }],
      'x-error-codes': codes,
    });
    expect(operation).not.toHaveProperty('x-implementation');
    const names = (operation.parameters ?? []).map((p) => p.name.toLowerCase());
    expect(names).not.toContain('idempotency-key');
    if (stepUp) {
      expect(operation.parameters).toContainEqual(
        expect.objectContaining({ name: 'X-Step-Up-Token', in: 'header', required: false }),
      );
    } else {
      expect(names).not.toContain('x-step-up-token');
    }
  },
);
