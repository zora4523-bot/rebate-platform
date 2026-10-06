// Runs the selected cases and publishes window.__RESULT__ (规划/03 §5.5). Bridge calls go only
// through the untyped conformance `invoke`; events through the SDK's `on()`. Method results are
// never stored: a success is recorded as `{ ok: true }` and a failure as its code.
import { bridge } from '@couli/contracts-ts';
import { isInApp, on } from '@couli/bridge-sdk';
import { invoke } from '@couli/bridge-sdk/conformance';
import {
  FRAME_CASE_ID,
  buildCaseTable,
  casesForPlatform,
  isPlatform,
  paramsForCase,
  selectCases,
} from './cases.ts';
import type {
  CaseOutcome,
  ConformanceCase,
  ConformancePlatform,
  ConformanceResult,
  FrameReport,
} from './model.ts';
import {
  completeAutoRuns,
  createResult,
  recordEvent,
  recordOutcome,
  replaceCases,
} from './result.ts';

export const FRAME_MESSAGE_TYPE: FrameReport['type'] = 'couli.bridge-conformance/frame';
/** Without a report from the subframe within this time, the subframe call did not succeed. */
export const FRAME_WAIT_MS = 3000;
const FRAME_SILENT: CaseOutcome = { ok: false, code: 90003 };
const NATIVE_ERROR = 90500;

function isBridgeErrorCode(code: unknown): code is number {
  return (bridge.bridgeErrorCodes as readonly unknown[]).includes(code);
}

/** Success, or the failure code only (never the native message or data). */
export async function probe(method: string, params: unknown): Promise<CaseOutcome> {
  try {
    await invoke(method, params);
    return { ok: true };
  } catch (error) {
    const code: unknown =
      typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    return { ok: false, code: isBridgeErrorCode(code) ? code : NATIVE_ERROR };
  }
}

/** Accepts only a well-formed subframe report and copies its outcome. */
export function readFrameReport(data: unknown): CaseOutcome | null {
  if (typeof data !== 'object' || data === null) return null;
  const { type, outcome } = data as { type?: unknown; outcome?: unknown };
  if (type !== FRAME_MESSAGE_TYPE || typeof outcome !== 'object' || outcome === null) return null;
  const { ok, code } = outcome as { ok?: unknown; code?: unknown };
  if (ok === true) return { ok: true };
  if (ok === false && isBridgeErrorCode(code)) return { ok: false, code };
  return null;
}

/** The App platform from app.getEnv; null outside the App or when the call fails. */
async function resolvePlatform(): Promise<ConformancePlatform | null> {
  try {
    const data: unknown = await invoke('app.getEnv', {});
    const platform =
      typeof data === 'object' && data !== null
        ? (data as { platform?: unknown }).platform
        : undefined;
    return isPlatform(platform) ? platform : null;
  } catch {
    return null;
  }
}

function elapsed(since: number): number {
  return Math.max(0, Math.round(performance.now() - since));
}

function publish(result: ConformanceResult): void {
  (window as unknown as { __RESULT__?: ConformanceResult }).__RESULT__ = result;
}

/** Page state for one load of the conformance entry; React reads it as an external store. */
export class ConformanceController {
  /** Same-origin URL of the subframe probe, or null when that case is not selected. */
  readonly frameSrc: string | null;
  private result: ConformanceResult;
  /** Selected rows before the platform filter (platform-limited rows wait for app.getEnv). */
  private readonly selected: ConformanceCase[];
  private readonly explicit: boolean;
  private readonly listeners = new Set<() => void>();
  private started = false;
  private disposed = false;
  private remaining = 0;
  private frameSettled = false;

  constructor(search: string, pathname: string) {
    const { cases, unknown_cases } = selectCases(buildCaseTable(), search);
    this.selected = cases;
    this.explicit = new URLSearchParams(search).has('cases');
    this.frameSrc = cases.some((row) => row.id === FRAME_CASE_ID)
      ? `${pathname}?frame=child`
      : null;
    // Until the platform is known only unrestricted rows exist (and none has run yet).
    this.result = createResult(casesForPlatform(cases, null), isInApp(), unknown_cases);
    publish(this.result);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): ConformanceResult => this.result;

  /**
   * Starts event recording, the subframe probe, then app.getEnv (the platform decides which
   * rows exist) followed by the sequential auto runs. The returned function stops all of them;
   * nothing is published after it.
   */
  start(frameWindow: () => Window | null): () => void {
    if (this.started) return () => this.dispose();
    this.started = true;
    const stops: (() => void)[] = [
      on('app.resume', (data) => this.update((result) => recordEvent(result, 'app.resume', data))),
      on('app.pause', (data) => this.update((result) => recordEvent(result, 'app.pause', data))),
    ];
    this.remaining = this.frameSrc === null ? 1 : 2;
    if (this.frameSrc !== null) stops.push(this.watchFrame(frameWindow));
    void this.runAll();
    const stop = () => {
      for (const fn of stops) fn();
    };
    this.stopAll = stop;
    return () => this.dispose();
  }

  /** Runs a tap row on a real user click (the click is the gesture native checks). */
  tap(id: string): void {
    const row = this.result.cases.find((candidate) => candidate.id === id);
    if (row === undefined || row.trigger !== 'tap') return;
    void this.execute(row);
  }

  private stopAll: () => void = () => {};

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAll();
    this.listeners.clear();
  }

  private update(change: (result: ConformanceResult) => ConformanceResult): void {
    if (this.disposed) return;
    this.result = change(this.result);
    publish(this.result);
    for (const listener of this.listeners) listener();
  }

  private finishOne(): void {
    this.remaining -= 1;
    if (this.remaining === 0) this.update(completeAutoRuns);
  }

  private async execute(row: ConformanceCase): Promise<void> {
    const since = performance.now();
    const outcome = await probe(row.method, paramsForCase(row));
    this.update((result) => recordOutcome(result, row.id, outcome, elapsed(since)));
  }

  /**
   * app.getEnv first, then one call at a time in table order, so native UI effects never
   * overlap. Loaded without `cases`: auto rows only; harness rows run only when named.
   */
  private async runAll(): Promise<void> {
    const platform = await resolvePlatform();
    if (this.disposed) return;
    this.update((result) => replaceCases(result, casesForPlatform(this.selected, platform)));
    const runs = this.result.cases.filter(
      (row) =>
        row.id !== FRAME_CASE_ID &&
        (row.trigger === 'auto' || (this.explicit && row.trigger === 'harness')),
    );
    for (const row of runs) {
      if (this.disposed) return;
      await this.execute(row);
    }
    this.finishOne();
  }

  /** 负面用例 ②: only a report from the embedded frame's window counts, and only the first. */
  private watchFrame(frameWindow: () => Window | null): () => void {
    const since = performance.now();
    const settle = (outcome: CaseOutcome) => {
      if (this.frameSettled) return;
      this.frameSettled = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      this.update((result) => recordOutcome(result, FRAME_CASE_ID, outcome, elapsed(since)));
      this.finishOne();
    };
    const onMessage = (event: MessageEvent) => {
      const child = frameWindow();
      if (child === null || event.source !== child) return;
      if (event.origin !== window.location.origin) return;
      const outcome = readFrameReport(event.data);
      if (outcome !== null) settle(outcome);
    };
    const timer = setTimeout(() => settle(FRAME_SILENT), FRAME_WAIT_MS);
    window.addEventListener('message', onMessage);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
    };
  }
}

/**
 * `?frame=child`: call one L0 method and report only success or the failure code to the parent.
 * No events, no buttons, no window.__RESULT__.
 */
export function runChildFrame(): () => void {
  let active = true;
  void probe('app.getEnv', {}).then((outcome) => {
    if (!active) return;
    const report: FrameReport = { type: FRAME_MESSAGE_TYPE, outcome };
    // '/' limits delivery to a parent on this page's own origin.
    window.parent.postMessage(report, '/');
  });
  return () => {
    active = false;
  };
}
