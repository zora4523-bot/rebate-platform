// Vitest reporter of the isolated red run (tools/ops/verify-container.sh --red; 规划/11 §2.3
// step 3; Codex review CR2-03). It writes the shape of Vitest's own JSON report (testResults[] of
// files with assertionResults[]) to the file named by RED_REPORT_OUT, plus what that report
// drops: every failure with its chain of causes (`failures[].causes`). fast-check keeps the error
// thrown inside a property only as `Error.cause`, so without this the red check could not tell a
// broken assertion from a TypeError or a refused database connection.
//
// Trusted file: mounted read-only from the trusted root, never taken from the task snapshot.
// Uses Node built-ins only and nothing of the repository under test.
import { writeFileSync } from 'node:fs';

/** name and message of an error and of every cause below it (at most 10 levels). */
function chain(error) {
  const out = [];
  let current = error;
  for (let depth = 0; depth < 10 && current !== undefined && current !== null; depth += 1) {
    if (typeof current !== 'object') {
      out.push({ name: typeof current, message: String(current) });
      break;
    }
    out.push({
      name: typeof current.name === 'string' ? current.name : 'Error',
      message: typeof current.message === 'string' ? current.message : '',
    });
    current = current.cause;
  }
  return out;
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
      const failures = (result.errors ?? []).map((e) => ({ causes: chain(e) }));
      assertionResults.push({
        fullName: testCase.fullName,
        title: testCase.name,
        status: result.state,
        failureMessages: (result.errors ?? []).map(text),
        failures,
      });
    }
    this.files.push({
      name: testModule.moduleId,
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
