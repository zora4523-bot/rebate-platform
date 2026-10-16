// Minimal types for container-provided k6 APIs; no npm runtime or Node imports.
declare function open(path: string): string;
declare const __ENV: Readonly<Record<string, string | undefined>>;

declare module 'k6' {
  export function check<T>(value: T, checks: Record<string, (value: T) => boolean>): boolean;
}

declare module 'k6/http' {
  export interface Response {
    status: number;
    body: string | null;
    headers: Record<string, string>;
  }
  const http: {
    request(
      method: string,
      url: string,
      body: string | null,
      params: {
        headers: Record<string, string>;
        redirects: number;
        timeout: string;
        responseType: 'text';
        tags: Record<string, string>;
        responseCallback: unknown;
      },
    ): Response;
    expectedStatuses(...statuses: number[]): unknown;
  };
  export default http;
}

declare module 'k6/crypto' {
  const crypto: {
    randomBytes(size: number): ArrayBuffer;
    sha256(value: string, encoding: 'hex'): string;
    hmac(algorithm: 'sha256', key: string, value: string, encoding: 'hex'): string;
  };
  export default crypto;
}

declare module 'k6/execution' {
  const exec: {
    vu: { idInTest: number };
    test: { abort(message: string): never };
  };
  export default exec;
}
