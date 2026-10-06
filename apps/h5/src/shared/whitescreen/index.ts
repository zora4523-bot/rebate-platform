export interface WhitescreenReport {
  kind: 'whitescreen';
  path: string;
  platform: string | null;
  version: string | null;
  elapsed_ms: number;
}

export interface WhitescreenOptions {
  root: HTMLElement;
  report: (event: WhitescreenReport) => void;
  env: { platform: string | null; version: string | null };
  timeoutMs?: number;
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => number;
  clearTimeout?: (handle: number) => void;
}

export function startWhitescreenWatch(options: WhitescreenOptions): () => void {
  void options;
  throw new Error('NotImplemented: startWhitescreenWatch');
}
