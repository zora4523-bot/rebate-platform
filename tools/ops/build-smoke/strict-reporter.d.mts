// Types of strict-reporter.mjs (plain JavaScript: Vitest loads it as a reporter by path).

export const DIAGNOSTICS_ANNOTATION: RegExp;
export function smokeDiagnosticsFindings(json: unknown): string[];
export function testCaseFindings(annotations: unknown): string[];

declare class StrictSmokeReporter {
  findings: string[];
  onTestModuleEnd(testModule: unknown): void;
  onTestRunEnd(): void;
}
export default StrictSmokeReporter;
