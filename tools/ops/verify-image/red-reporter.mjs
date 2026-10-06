// Vitest reporter of the isolated red run (tools/ops/verify-container.sh --red; 规划/11 §2.3
// step 3; Codex review CR2-03). It writes the shape of Vitest's own JSON report (testResults[] of
// files with assertionResults[]) to the file named by RED_REPORT_OUT, plus what that report
// drops: every failure with its chain of causes (`failures[].causes`). fast-check keeps the error
// thrown inside a property only as `Error.cause`, so without this the red check could not tell a
// broken assertion from a TypeError or a refused database connection.
//
// Browser tests (F1-01j, Vitest browser mode): each file records `browser: true` when its project
// ran in a real browser, and a cause records `matcher` when it is the failure of a matcher added
// with expect.extend — the jest-dom style matchers of expect.element (toBeVisible …) throw a plain
// Error carrying `__vitest_error_context__.assertionName` (vitest 5.0.1 JestExtendError), not an
// AssertionError. Two more fields let red-check tell an expect.element wait from a generic
// expect.poll one (both end in the same "expect.poll() function didn't resolve in time." when the
// wait runs out before the element lookup gives up; Codex review of F1-01j, S2): `site` of a
// failure is the first stack frame outside the dependencies (node_modules, Vite's pre-bundled
// deps, where vitest's own poll frame lives) — the line that started the wait — with the browser's
// `http://localhost:<port>` prefix and query removed (null when there is none); `poll_in_source`
// of a file says whether its code — comments and string literals left out — uses `poll` (an
// expect.poll call, `['poll']`, any identifier `poll`); true when it cannot be read.
// tools/guard/lib/red-check.ts reads them. Real stacks of a red run (2026-10-06, F1-01j red/1):
// Vitest's parsed stack starts with the pre-bundled __VITEST_POLL_CHAIN__ frame
// (/work/repo/test/node_modules/.vite/vitest/…/deps/…), the raw stack with
// http://localhost:63315/node_modules/.vite/…; the test file follows as
// http://localhost:63315/work/repo/test/spec/…/x.browser.test.ts?import&browserv=…:8:68.
//
// Build smoke tests (F1-01k): a page that throws while rendering only fires Playwright's
// `pageerror`; the rule tests collect such events into an annotation (context.annotate) whose
// attachment body is JSON `{entry, url, diagnostics: [{kind, message}]}`, and the test itself then
// fails on a locator.waitFor timeout. So every test records its `annotations` (message, type, the
// attachment's content type and path, and `json`: the attachment body parsed, when it is JSON);
// red-check refuses a red whose diagnostics show a page error.
//
// Trusted file: mounted read-only from the trusted root, never taken from the task snapshot.
// Uses Node built-ins only and nothing of the repository under test.
import { readFileSync, writeFileSync } from 'node:fs';

/** name and message of an error and of every cause below it (at most 10 levels). */
function chain(error) {
  const out = [];
  let current = error;
  for (let depth = 0; depth < 10 && current !== undefined && current !== null; depth += 1) {
    if (typeof current !== 'object') {
      out.push({ name: typeof current, message: String(current) });
      break;
    }
    const entry = {
      name: typeof current.name === 'string' ? current.name : 'Error',
      message: typeof current.message === 'string' ? current.message : '',
    };
    const matcher = current.__vitest_error_context__?.assertionName;
    if (typeof matcher === 'string' && matcher !== '') entry.matcher = matcher;
    out.push(entry);
    current = current.cause;
  }
  return out;
}

/**
 * The file path of a stack frame: without the browser's http://localhost:<port> (or file://, or
 * Vite's /@fs) prefix and without a query or hash.
 */
export function frameFile(raw) {
  return String(raw)
    .replace(/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?=\/)/, '')
    .replace(/^file:\/\//, '')
    .replace(/^\/@fs(?=\/)/, '')
    .replace(/[?#].*$/, '');
}

/** A frame of the dependencies (or of no file): vitest's own frames live there. */
function dependencyFrame(file) {
  return !file.startsWith('/') || file.includes('/node_modules/');
}

/** Frames of a raw V8 stack text: `at fn (file:line:col)` or `at file:line:col`. */
function rawFrames(stack) {
  const frames = [];
  for (const line of String(stack).split('\n')) {
    const m = /^\s*at (?:.*? \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (m !== null) frames.push({ file: m[1], line: Number(m[2]), column: Number(m[3]) });
  }
  return frames;
}

/**
 * Where the failing call was made: the first frame outside the dependencies, from Vitest's parsed
 * stack, else from the raw stack text; null when neither has one.
 */
export function userSite(error) {
  const parsed = Array.isArray(error?.stacks) ? error.stacks : [];
  for (const frames of [parsed, rawFrames(error?.stack ?? '')]) {
    for (const frame of frames) {
      if (frame === null || typeof frame !== 'object' || typeof frame.file !== 'string') continue;
      const file = frameFile(frame.file);
      if (dependencyFrame(file)) continue;
      return {
        file,
        line: typeof frame.line === 'number' ? frame.line : null,
        column: typeof frame.column === 'number' ? frame.column : null,
      };
    }
  }
  return null;
}

/**
 * True when the code of `source` uses `poll`: an identifier `poll` (expect.poll(…), a destructured
 * or renamed poll) or a computed `['poll']`, with comments and the text of string and template
 * literals left out (template `${…}` expressions are code). Element texts such as
 * getByRole('button', { name: 'poll' }) and comments therefore do not count.
 */
export function pollInCode(source) {
  let code = '';
  let i = 0;
  const n = source.length;
  // Template nesting: each entry counts the open braces of one `${…}` expression.
  const templates = [];
  const quoted = (q) => {
    // Skips a '…' or "…" literal (ends at the quote or at a line end), keeping a placeholder.
    let j = i + 1;
    let body = '';
    while (j < n && source[j] !== q && source[j] !== '\n') {
      if (source[j] === '\\') j += 1;
      else body += source[j];
      j += 1;
    }
    i = j + 1;
    return body;
  };
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else if (c === "'" || c === '"') {
      code += quoted(c) === 'poll' ? `${c}poll${c}` : `${c}${c}`;
    } else if (c === '`' || (c === '}' && templates.length > 0 && templates.at(-1) === 0)) {
      // A template literal, or the rest of one after a `${…}` expression closed.
      if (c === '}') templates.pop();
      let j = i + 1;
      while (j < n && source[j] !== '`' && !(source[j] === '$' && source[j + 1] === '{')) {
        if (source[j] === '\\') j += 1;
        j += 1;
      }
      code += '``';
      if (j < n && source[j] === '$') {
        templates.push(0);
        i = j + 2;
      } else {
        i = j + 1;
      }
    } else {
      if (templates.length > 0) {
        if (c === '{') templates[templates.length - 1] += 1;
        else if (c === '}') templates[templates.length - 1] -= 1;
      }
      code += c;
      i += 1;
    }
  }
  const computed = /\[\s*(['"])poll\1\s*\]/.test(code);
  return computed || /\bpoll\b/.test(code.replace(/(['"])poll\1/g, ' '));
}

/** True unless the test file can be read and its code does not use `poll` (pollInCode). */
function pollInSource(file) {
  try {
    return pollInCode(readFileSync(file, 'utf8'));
  } catch {
    return true;
  }
}

/**
 * The text of an attachment body, or null when there is none. Vitest 5.0.1 labels a string body
 * `bodyEncoding: 'base64'` unless the test said otherwise, also when the test passed plain text
 * (manageArtifactAttachment): a body that parses as JSON as it is is taken as it is; otherwise a
 * base64 body is decoded.
 */
export function attachmentText(attachment) {
  if (attachment === null || typeof attachment !== 'object' || attachment.body == null) return null;
  const body = attachment.body;
  if (typeof body !== 'string') {
    try {
      return Buffer.from(body).toString('utf8');
    } catch {
      return null;
    }
  }
  if (attachment.bodyEncoding === 'utf-8') return body;
  try {
    JSON.parse(body);
    return body;
  } catch {
    // not JSON as it is: decoded below when it is base64
  }
  if (body.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(body)) {
    return Buffer.from(body, 'base64').toString('utf8');
  }
  return body;
}

/** One annotation of a test as the report keeps it (see the header). */
export function annotationRecord(annotation) {
  const a = annotation !== null && typeof annotation === 'object' ? annotation : {};
  const out = {
    message: typeof a.message === 'string' ? a.message : '',
    type: typeof a.type === 'string' ? a.type : '',
  };
  const attachment = a.attachment;
  if (attachment !== null && typeof attachment === 'object') {
    if (typeof attachment.contentType === 'string') out.content_type = attachment.contentType;
    if (typeof attachment.path === 'string') out.path = attachment.path;
    const body = attachmentText(attachment);
    if (body !== null) {
      try {
        out.json = JSON.parse(body);
      } catch {
        // not JSON: only JSON bodies are kept
      }
    }
  }
  return out;
}

function annotationsOf(testCase) {
  try {
    const list = typeof testCase.annotations === 'function' ? testCase.annotations() : [];
    return Array.isArray(list) ? list.map(annotationRecord) : [];
  } catch {
    return [];
  }
}

function text(error) {
  if (error === null || typeof error !== 'object') return String(error);
  return typeof error.stack === 'string' && error.stack !== ''
    ? error.stack
    : String(error.message);
}

export default class RedReporter {
  files = [];

  onTestModuleEnd(testModule) {
    const errors = typeof testModule.errors === 'function' ? testModule.errors() : [];
    const assertionResults = [];
    for (const testCase of testModule.children.allTests()) {
      const result = testCase.result();
      const failures = (result.errors ?? []).map((e) => ({ causes: chain(e), site: userSite(e) }));
      assertionResults.push({
        fullName: testCase.fullName,
        title: testCase.name,
        status: result.state,
        failureMessages: (result.errors ?? []).map(text),
        failures,
        annotations: annotationsOf(testCase),
      });
    }
    this.files.push({
      name: testModule.moduleId,
      browser: testModule.project?.config?.browser?.enabled === true,
      poll_in_source: pollInSource(testModule.moduleId),
      status: testModule.state(),
      message: errors.map(text).join('\n'),
      failures: errors.map((e) => ({ causes: chain(e) })),
      assertionResults,
    });
  }

  onTestRunEnd(_modules, unhandledErrors) {
    const out = process.env.RED_REPORT_OUT;
    if (!out) throw new Error('RED_REPORT_OUT is not set');
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          reporter: 'couli-red-reporter',
          testResults: this.files,
          unhandledErrors: (unhandledErrors ?? []).map((e) => ({ causes: chain(e) })),
        },
        null,
        2,
      )}\n`,
    );
  }
}
