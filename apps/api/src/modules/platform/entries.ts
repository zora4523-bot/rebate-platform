// The five process entries (ADR-0001 §2 进程入口).
export const HTTP_ENTRIES = ['api', 'stream', 'admin'] as const;
export const WORKER_ENTRIES = ['worker', 'payout'] as const;

export type HttpEntry = (typeof HTTP_ENTRIES)[number];
export type WorkerEntry = (typeof WORKER_ENTRIES)[number];
export type EntryName = HttpEntry | WorkerEntry;

export function isHttpEntry(entry: EntryName): entry is HttpEntry {
  return (HTTP_ENTRIES as readonly string[]).includes(entry);
}
