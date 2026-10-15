// Exercise the real generator with a dereferenced contract fixture. Only the document loader
// is replaced: neither routeSchemaOf nor its Ajv compiler is mocked, and no file is generated.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import type {
  ContractOperation,
  ContractParameter,
  RouteSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';

interface Document {
  paths: Record<string, { parameters?: ContractParameter[]; post: ContractOperation }>;
}

it('[AC-F1-06s#3] 生成器接纳实际上传契约且不把 multipart 标记当作 Ajv schema 编译', async () => {
  const apiRequire = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
  // Match the package's `import` export used by the generator, not its `require` export.
  const parserPath = fileURLToPath(
    new URL(
      './dist/index.js',
      pathToFileURL(apiRequire.resolve('@readme/openapi-parser/package.json')),
    ),
  );
  const parser = (await import(pathToFileURL(parserPath).href)) as {
    dereference(path: string, options: object): Promise<Document>;
  };
  const document = await parser.dereference(
    fileURLToPath(new URL('../../../../contracts/openapi.yaml', import.meta.url)),
    { resolve: { external: false } },
  );
  const path = '/admin/v1/platform-icons/{key}/uploads';
  const item = document.paths[path];
  expect(item?.post.operationId).toBe('adminUploadPlatformIcon');
  // Simulate F1-06x removing planned, in memory only. The repository contract stays untouched.
  const operation: Record<string, unknown> = { ...item?.post };
  delete operation['x-implementation'];
  const fixture = {
    ...document,
    paths: { [path]: { ...item, post: operation } },
  };
  const dereference = vi.fn(async () => fixture);
  vi.resetModules();
  vi.doMock(parserPath, () => ({ dereference }));
  try {
    const generator =
      await import('../../../../apps/api/src/modules/platform/validation/scripts/generate-route-schemas.ts');
    let source: string;
    try {
      try {
        source = await generator.routeSchemasSource();
      } finally {
        // Check fixture delivery before interpreting either generated output or a refusal.
        expect(dereference).toHaveBeenCalledExactlyOnceWith(
          fileURLToPath(new URL('../../../../contracts/openapi.yaml', import.meta.url)),
          { resolve: { external: false } },
        );
        await expect(dereference.mock.results[0]?.value).resolves.toBe(fixture);
      }
    } catch (error) {
      // A contract-shape refusal of this supported operation is the missing feature.
      // Preserve loader failures, TypeError and other setup errors as invalid red causes.
      if (
        error instanceof Error &&
        error.name === 'Error' &&
        error.message.startsWith('adminUploadPlatformIcon:')
      ) {
        expect.fail(`生成器拒绝了合法 multipart 操作：${error.message}`);
      }
      throw error;
    }
    const match = /export const CONTRACT_ROUTE_SCHEMAS = ([\s\S]+) as const;/.exec(source);
    expect(match?.[1]).toBeDefined();
    const schemas = JSON.parse(match?.[1] ?? '{}') as Record<string, RouteSchema>;
    const schema = schemas['adminUploadPlatformIcon'];
    expect(schema?.multipart).toBe(true);
    expect(schema).not.toHaveProperty('body');
    expect(schema).toMatchObject({
      params: { required: ['key'] },
      headers: { properties: { 'x-trace-id': expect.any(Object) } },
    });
    for (const requestBody of [
      { ...item?.post.requestBody, required: false },
      {
        required: true,
        content: {
          ...item?.post.requestBody?.content,
          'application/json': { schema: { type: 'object' } },
        },
      },
    ]) {
      operation['requestBody'] = requestBody;
      await expect(generator.routeSchemasSource()).rejects.toThrow('adminUploadPlatformIcon');
    }
  } finally {
    vi.doUnmock(parserPath);
    vi.resetModules();
  }
});
