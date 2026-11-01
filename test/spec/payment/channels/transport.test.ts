// B2-15k 默认 transport（claude-independent，SPEC_REF deb521c2）：任务书 9.10：用 fetch，不跟随重定向，有超时和响应大小
// 上限。假服务端只听 127.0.0.1（kit.ts withServer；任务书 9.12 允许）。每个测试先走一次正常调用，防止「抛异常就算过」
// 把骨架的 NotImplemented 也当成合格。
import { expect, it } from 'vitest';
import { fetchPayTransport } from '../../../../apps/api/src/modules/payment/infra/channels/transport.ts';
import { withServer } from './kit.ts';

const REQUEST = { method: 'GET', headers: {}, timeoutMs: 2000 } as const;

it('[AC-B2-15k#1701] 正常调用：状态码、头名小写、正文文本、字节都带回；请求方法、头、正文原样发出', async () => {
  const seen: { method?: string; custom?: string; body?: string } = {};
  await withServer(
    (request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        seen.method = request.method ?? '';
        seen.custom = String(request.headers['x-custom']);
        seen.body = Buffer.concat(chunks).toString('utf8');
        response.writeHead(201, { 'X-Answer': 'yes' });
        response.end('正文');
      });
    },
    async (base) => {
      const answer = await fetchPayTransport({
        method: 'POST',
        url: `${base}/echo`,
        headers: { 'X-Custom': 'value' },
        body: 'payload',
        timeoutMs: 2000,
      });
      expect(answer.status).toBe(201);
      expect(answer.headers['x-answer']).toBe('yes');
      expect(answer.body).toBe('正文');
      expect(Buffer.from(answer.bytes ?? new Uint8Array()).toString('utf8')).toBe('正文');
      expect(seen).toEqual({ method: 'POST', custom: 'value', body: 'payload' });
    },
  );
});

it('[AC-B2-15k#1702] 不跟随重定向：302 的目标一次都没被请求（资金接口不跟随，通知地址文档也不许重定向）', async () => {
  let targetHits = 0;
  await withServer(
    (request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { Location: '/target' });
        response.end();
        return;
      }
      targetHits += 1;
      response.end('target');
    },
    async (base) => {
      const plain = await fetchPayTransport({ ...REQUEST, url: `${base}/target` });
      expect(plain.body).toBe('target');
      targetHits = 0;
      let status: number | null = null;
      try {
        status = (await fetchPayTransport({ ...REQUEST, url: `${base}/redirect` })).status;
      } catch {
        status = null;
      }
      expect(status === null || status === 302).toBe(true);
      expect(targetHits).toBe(0);
    },
  );
});

it('[AC-B2-15k#1703] 超时：服务端不应答时按 timeoutMs 结束（reject），不挂住', async () => {
  await withServer(
    (request, response) => {
      if (request.url === '/quick') response.end('quick');
    },
    async (base) => {
      const plain = await fetchPayTransport({ ...REQUEST, url: `${base}/quick` });
      expect(plain.body).toBe('quick');
      await expect(
        fetchPayTransport({ ...REQUEST, url: `${base}/hang`, timeoutMs: 50 }),
      ).rejects.toBeDefined();
    },
  );
});

it('[AC-B2-15k#1704] 响应大小上限：声明长度超限或分块超限都 reject；未超限的照常返回', async () => {
  const big = 'x'.repeat(4096);
  await withServer(
    (request, response) => {
      if (request.url === '/small') {
        response.end('small');
      } else if (request.url === '/declared') {
        response.writeHead(200, { 'Content-Length': String(big.length) });
        response.end(big);
      } else {
        response.writeHead(200);
        response.write(big.slice(0, 2048));
        response.end(big.slice(2048));
      }
    },
    async (base) => {
      const limited = { ...REQUEST, maxResponseBytes: 1024 };
      const small = await fetchPayTransport({ ...limited, url: `${base}/small` });
      expect(small.body).toBe('small');
      await expect(
        fetchPayTransport({ ...limited, url: `${base}/declared` }),
      ).rejects.toBeDefined();
      await expect(fetchPayTransport({ ...limited, url: `${base}/chunked` })).rejects.toBeDefined();
    },
  );
});
