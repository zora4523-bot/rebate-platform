// Types of the helpers red-reporter.mjs exports for its tests (plain JavaScript, because the file
// is mounted read-only into the verify container and loaded by Vitest as a reporter).

export type FrameSite = { file: string; line: number | null; column: number | null };

export function frameFile(raw: unknown): string;
export function userSite(error: unknown): FrameSite | null;
export function pollInCode(source: string): boolean;

declare class RedReporter {
  files: unknown[];
  onTestModuleEnd(testModule: unknown): void;
  onTestRunEnd(modules: unknown, unhandledErrors: unknown): void;
}
export default RedReporter;
