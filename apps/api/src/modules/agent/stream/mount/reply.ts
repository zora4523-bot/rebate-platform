import type { ServerResponse } from 'node:http';
import type { AgentHttpReply } from '../../http/index.ts';

/** Only the Fastify surface used here; no second HTTP adapter or dependency. */
export interface StreamReply {
  readonly raw: ServerResponse;
  code(status: number): this;
  headers(values: Readonly<Record<string, string>>): this;
  send(body: unknown): this;
  hijack(): this;
}

export function agentHttpReply(reply: StreamReply, traceId: string): AgentHttpReply {
  return {
    json(status, headers, body) {
      reply.code(status).headers(headers).send(body);
    },
    stream(headers) {
      const response = reply.raw;
      reply.hijack();
      // Hijacking bypasses Fastify's onSend hook; preserve its trace header explicitly.
      response.writeHead(200, { ...headers, 'x-trace-id': traceId });
      response.flushHeaders();
      let closed = response.destroyed;
      let ended = false;
      const listeners = new Set<() => void>();
      const close = (): void => {
        if (closed) return;
        closed = true;
        for (const listener of listeners) listener();
        listeners.clear();
      };
      response.once('close', close);
      response.once('error', close);
      return {
        onClose(listener) {
          if (closed) listener();
          else if (!ended) listeners.add(listener);
        },
        write(chunk) {
          if (closed || ended || response.destroyed || response.writableEnded) {
            close();
            throw new Error('Agent stream closed');
          }
          // false means buffered backpressure, not a failed delivery.
          response.write(chunk);
        },
        end() {
          if (ended) return;
          ended = true;
          listeners.clear();
          if (!closed && !response.destroyed) response.end();
        },
      };
    },
  };
}
