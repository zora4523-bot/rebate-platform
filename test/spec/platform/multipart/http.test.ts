import { beforeAll, expect, it } from 'vitest';
import {
  BODY_LIMIT,
  BYTES,
  TRACE,
  envelopeValidator,
  expectError,
  expectUpload,
  filePart,
  multipart,
  request,
  withApp,
} from './http-kit.ts';

let validate: Awaited<ReturnType<typeof envelopeValidator>>;
beforeAll(async () => {
  validate = await envelopeValidator();
});

it('[AC-F1-06s#4] admin 通过 platform 公共出口读回单文件原始字节、文件名和 MIME，不附加 body', async () => {
  await withApp('admin', async (app) => {
    expectUpload(await app.inject(request(multipart([filePart()]))));
  });
});

it.each([
  ['没有 part', []],
  ['file 名错误', [filePart(BYTES, 'image')]],
  ['两个文件', [filePart(), filePart()]],
  ['先文件再普通字段', [filePart(), { name: 'extra', bytes: BYTES }]],
  ['先普通字段再文件', [{ name: 'extra', bytes: BYTES }, filePart()]],
  ['只有普通字段 file', [{ name: 'file', bytes: BYTES }]],
] as const)(
  '[AC-F1-06s#5] admin %s 返回 400 / 20001 / fields=[file] 且不泄露上传信息',
  async (_label, parts) => {
    await withApp('admin', async (app) => {
      expectError(await app.inject(request(multipart(parts))), validate, 400, 'file');
    });
  },
);

it('[AC-F1-06s#6] 非 multipart JSON 请求调用读取函数返回 file 字段错误', async () => {
  await withApp('admin', async (app) => {
    expectError(
      await app.inject(request(Buffer.from('{}'), { contentType: 'application/json' })),
      validate,
      400,
      'file',
    );
  });
});

it.each([false, true])(
  '[AC-F1-06s#7] 文件超过 1 MiB（chunked=%s）返回 413 / 20001 / fields=[body]',
  async (chunked) => {
    const bytes = Buffer.concat([BYTES, Buffer.alloc(BODY_LIMIT + 1 - BYTES.length, 97)]);
    await withApp('admin', async (app) => {
      expectError(
        await app.inject(request(multipart([filePart(bytes)]), { chunked })),
        validate,
        413,
        'body',
      );
    });
  },
  30_000,
);

it.each([false, true])(
  '[AC-F1-06s#8] 整体请求体的 1 MiB 边界（chunked=%s）包含 multipart 开销',
  async (chunked) => {
    const overhead = multipart([filePart(Buffer.alloc(0))]).length;
    const bytes = Buffer.alloc(BODY_LIMIT - overhead, 97);
    const atLimit = multipart([filePart(bytes)]);
    const aboveLimit = multipart([filePart(Buffer.concat([bytes, Buffer.from('a')]))]);
    expect(atLimit.length).toBe(BODY_LIMIT);
    expect(aboveLimit.length).toBe(BODY_LIMIT + 1);
    await withApp('admin', async (app) => {
      // The second file itself is below fileSize: enforcing only that limit is insufficient.
      expectUpload(await app.inject(request(atLimit, { chunked })), bytes);
      expectError(await app.inject(request(aboveLimit, { chunked })), validate, 413, 'body');
    });
  },
  30_000,
);

it('[AC-F1-06s#9] 只有 admin 接受 multipart，api 与 stream 对同样请求保持 415 契约错误', async () => {
  const input = request(multipart([filePart()]));
  for (const entry of ['api', 'stream'] as const) {
    await withApp(entry, async (app) => {
      expectError(await app.inject(input), validate, 415, 'body');
    });
  }
  // Pair the existing 415 behavior with the new admin behavior: this rule must start red.
  await withApp('admin', async (app) => {
    expectUpload(await app.inject(input));
  });
}, 30_000);

it('[AC-F1-06s#10] multipart 流留给 handler，守卫拒绝时不预读或挂载文件到 body', async () => {
  await withApp('admin', async (app) => {
    const response = await app.inject(request(multipart([filePart()]), { guarded: true }));
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      code: 10403,
      msg: 'probe guard refused',
      trace_id: TRACE,
      data: { bodyWasUndefined: true, streamEnded: false },
    });
    expectUpload(await app.inject(request(multipart([filePart()]))));
  });
});
