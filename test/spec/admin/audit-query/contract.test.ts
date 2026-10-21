import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { apiRequire } from '../auth/kit.ts';
import { DETAIL, LIST } from './kit.ts';

it.each([
  [LIST, 'adminListAuditLogs'],
  [DETAIL, 'adminGetAuditLog'],
])(
  '[AC-B1-34a#16] %s 保持登录鉴权并移除 planned，示例使用真实 action',
  async (path, operationId) => {
    const parser = apiRequire('@readme/openapi-parser') as {
      dereference(
        path: string,
        options: object,
      ): Promise<{
        paths: Record<
          string,
          {
            get: {
              operationId: string;
              'x-auth': string;
              'x-implementation'?: string;
              responses: Record<
                string,
                {
                  content: Record<
                    string,
                    {
                      example: {
                        data: Record<string, unknown> & { items?: Record<string, unknown>[] };
                      };
                    }
                  >;
                }
              >;
            };
          }
        >;
      }>;
    };
    const doc = await parser.dereference(
      fileURLToPath(new URL('../../../../contracts/openapi.yaml', import.meta.url)),
      { resolve: { external: false } },
    );
    const operation = doc.paths[path]!.get;
    expect(operation).toMatchObject({ operationId, 'x-auth': 'admin' });
    // Source and generated route tables remain untouched during the test phase.
    expect(operation['x-implementation']).not.toBe('planned');
    const data = operation.responses['200']!.content['application/json']!.example.data;
    if (path === LIST) {
      expect(data.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: 'admin.login', ip: expect.any(String) }),
        ]),
      );
      expect(data.items?.some((item) => item.action === 'login')).toBe(false);
    } else {
      expect(data.action).toBe('user_risk_state_change');
      expect(data.after).toMatchObject({ action: 'ban' });
    }
  },
);
