// F1-02zzs §9.2#5: the transitional sentence of CT-02zb is removed; nothing else in the shape of
// the three admin agreement operations changes.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const ROOT = new URL('../../../../', import.meta.url);

interface Operation {
  operationId: string;
  description: string;
  parameters: { name: string; in: string; schema?: { enum?: unknown } }[];
}

async function document() {
  const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));
  const parser = apiRequire('@readme/openapi-parser') as {
    dereference(
      path: string,
      options: object,
    ): Promise<{ paths: Record<string, Record<string, Operation>> }>;
  };
  return parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
    resolve: { external: false },
  });
}

const FIVE = ['privacy', 'agreement', 'labor_agreement', 'sdk_list', 'collect_list'];

it('[AC-F1-02zzs#6] 发布操作删去「F1-02zzs 合并前回 20001 [type]」过渡句，两类规则句与五值类型保留', async () => {
  const doc = await document();
  const operation = doc.paths['/admin/v1/agreements/{type}/versions']!['post']!;
  expect(operation.operationId).toBe('adminPublishAgreementVersion');
  const text = operation.description.replace(/\s+/g, ' ');
  expect(text).not.toContain('Until F1-02zzs is merged');
  expect(text).not.toContain('data.fields=[type]');
  expect(text).toContain(
    'sdk_list and collect_list take no part in consent (D10-465), so their min_version must equal the new version and requires_resign must be false',
  );
  for (const [path, method] of [
    ['/admin/v1/agreements/{type}/versions', 'post'],
    ['/admin/v1/agreements/{type}/versions/{version}', 'get'],
    ['/v1/agreements/{type}', 'get'],
  ] as const) {
    const type = doc.paths[path]![method]!.parameters.find(
      (parameter) => parameter.name === 'type' && parameter.in === 'path',
    );
    expect(type?.schema?.enum, `${method} ${path}`).toEqual(FIVE);
  }
  const listType = doc.paths['/admin/v1/agreements']!['get']!.parameters.find(
    (parameter) => parameter.name === 'type' && parameter.in === 'query',
  );
  expect(listType?.schema?.enum).toEqual(FIVE);
});
