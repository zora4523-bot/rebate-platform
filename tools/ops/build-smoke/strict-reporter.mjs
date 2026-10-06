// Strict reporter of the build smoke (F1-01k; test/vitest.build-smoke.config.ts, `test:smoke`;
// Codex review r2, S1). The rule tests collect what the page did while they ran into one
// annotation per entry they open, "<entry> 浏览器诊断（不作为断言）", whose JSON attachment is
// `{entry, url, diagnostics: [{kind, message}]}`; the tests never assert on it, so a page that
// threw or lost one of its own files while its first screen still showed up would pass. This
// reporter reads those annotations of every test and makes the run fail (exit code 1, the entry
// and the messages listed on stderr) when any of them shows:
//   - a `pageerror` (an uncaught error of the page; none excepted, not even NotImplemented: the
//     run is meant to be green);
//   - a `requestfailed` of the entry's own origin, unless the test blocked that request itself (a
//     `blocked-request` of the same URL: /v1/**, /admin/v1/**, non-GET);
//   - a module of the page that did not load (`console.error` of a failed dynamic import);
//   - a diagnostics annotation without a readable `diagnostics` list (fail closed).
// Cross-origin requests are all blocked by the tests and other console output stays evidence
// only. Used by the build-smoke project alone (its config; `verify-container.sh --browser` adds it
// for that project too). The isolated red run (`--red`) replaces it with the red reporter: there
// the same diagnostics decide whether a red counts (tools/guard/lib/red-check.ts).
//
// Trusted file (tools/**): Node built-ins and the trusted red reporter's attachment reader only.
import { annotationRecord } from '../verify-image/red-reporter.mjs';

/** The title of a diagnostics annotation of the build smoke rule tests. */
export const DIAGNOSTICS_ANNOTATION = /浏览器诊断（不作为断言）$/;

/** A failed dynamic import, as the browser logs it (Chromium and others). */
const MODULE_DID_NOT_LOAD =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/;

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function str(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * What a green build smoke run must not show, from one diagnostics attachment (parsed JSON):
 * one line per finding, empty when there is none (see the header).
 */
export function smokeDiagnosticsFindings(json) {
  if (json === null || typeof json !== 'object' || !Array.isArray(json.diagnostics)) {
    return ['diagnostics annotation without a readable diagnostics list'];
  }
  const own = originOf(str(json.url));
  const list = json.diagnostics.map((d) =>
    d !== null && typeof d === 'object'
      ? { kind: str(d.kind), message: str(d.message) }
      : { kind: '', message: '' },
  );
  const blocked = new Set(list.filter((d) => d.kind === 'blocked-request').map((d) => d.message));
  const findings = [];
  for (const d of list) {
    const first = d.message.split('\n')[0] ?? '';
    if (d.kind === 'pageerror') {
      findings.push(`the page threw: ${first}`);
    } else if (d.kind === 'requestfailed') {
      // "<url>: <errorText>" (the rule tests' format)
      const at = d.message.lastIndexOf(': ');
      const url = at < 0 ? d.message : d.message.slice(0, at);
      if (blocked.has(url)) continue;
      const origin = originOf(url);
      if (own === null || origin === null || origin === own) {
        findings.push(`a request of the entry failed: ${first}`);
      }
    } else if (d.kind === 'console.error' && MODULE_DID_NOT_LOAD.test(d.message)) {
      findings.push(`a module of the page did not load: ${first}`);
    }
  }
  return findings;
}

/** Findings of one test from its annotations (as Vitest gives them), each prefixed by the entry. */
export function testCaseFindings(annotations) {
  const out = [];
  for (const raw of Array.isArray(annotations) ? annotations : []) {
    const record = annotationRecord(raw);
    if (!DIAGNOSTICS_ANNOTATION.test(record.message)) continue;
    const entry =
      record.json !== null &&
      typeof record.json === 'object' &&
      typeof record.json.entry === 'string'
        ? record.json.entry
        : record.message;
    for (const finding of smokeDiagnosticsFindings(record.json)) out.push(`${entry}: ${finding}`);
  }
  return out;
}

export default class StrictSmokeReporter {
  /** `<test full name> — <entry>: <finding>` lines collected over the run. */
  findings = [];

  onTestModuleEnd(testModule) {
    for (const testCase of testModule.children.allTests()) {
      let annotations = [];
      try {
        annotations = typeof testCase.annotations === 'function' ? testCase.annotations() : [];
      } catch {
        annotations = [];
      }
      for (const finding of testCaseFindings(annotations)) {
        this.findings.push(`${testCase.fullName} — ${finding}`);
      }
    }
  }

  onTestRunEnd() {
    if (this.findings.length === 0) return;
    process.exitCode = 1;
    process.stderr.write(
      [
        '',
        `[build-smoke strict] ${this.findings.length} page problem(s) in the browser diagnostics; the run fails:`,
        ...this.findings.map((f) => `  - ${f}`),
        '',
      ].join('\n'),
    );
  }
}
