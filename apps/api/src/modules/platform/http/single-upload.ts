import type { IncomingMessage } from 'node:http';
import type { Multipart } from '@fastify/multipart';

/** Structural Fastify request; the admin entry installs the multipart methods. */
export interface SingleUploadRequest {
  readonly id: string;
  readonly headers: IncomingMessage['headers'];
  readonly raw: IncomingMessage;
  readonly routeOptions: { readonly bodyLimit: number };
  isMultipart(): boolean;
  parts(): AsyncIterableIterator<Multipart>;
}

export interface SingleUpload {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mimetype: string;
}

/** Called by the handler after its guards; accepts exactly one part named `file`. */
export async function readSingleUpload(request: SingleUploadRequest): Promise<SingleUpload> {
  void request;
  throw new Error('NotImplemented: readSingleUpload');
}
