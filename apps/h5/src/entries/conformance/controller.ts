// Runs the selected cases and publishes window.__RESULT__ (规划/03 §5.5). Bridge calls go only
// through the untyped conformance `invoke`; events through the conformance `onRaw()`, which keeps
// native data unfiltered so contract violations stay visible. Method results are never stored:
// a success is recorded as `{ ok: true }` and a failure as its code.
import { bridge } from '@couli/contracts-ts';
import { isInApp } from '@couli/bridge-sdk';
import { invoke, onRaw } from '@couli/bridge-sdk/conformance';
import {
  FRAME_CASE_ID,
  NO_GESTURE_WAIT_MS,
  buildCaseTable,
  casesForPlatform,
  contractTimeoutMs,
  isPlatform,
  needsGesture,
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
/**
 * Per-case watchdog of the automatic run. Sync methods and several async ones have no contract
 * timeout (timeout_ms null), so a native side that never replies would stall the queue and keep
 * status at 'running'. 15 s is the longest contract timeout (net.signedRequest); methods that do
 * have a timeout get it on top, so the SDK's own 90003 always comes first.
 */
export const CASE_WATCHDOG_MS = 15_000;
const CASE_SILENT: CaseOutcome = { ok: false, code: 90003 };
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
  private lastGestureAt: number | null = null;
  private cancelGestureWait: (() => void) | null = null;
  private readonly watchdogs = new Set<ReturnType<typeof setTimeout>>();

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
    const recordGesture = (event: Event) => {
      if (event.isTrusted) this.lastGestureAt = performance.now();
    };
    // Capture clicks anywhere on the page; pointer and touch events also cover taps on disabled
    // buttons or blank areas, which can refresh native gesture state without dispatching a click.
    const gestureEvents = ['click', 'pointerdown', 'pointerup', 'touchend'] as const;
    for (const type of gestureEvents) window.addEventListener(type, recordGesture, true);
    const stops: (() => void)[] = [
      () => {
        for (const type of gestureEvents) window.removeEventListener(type, recordGesture, true);
      },
      onRaw('app.resume', (data) =>
        this.update((result) => recordEvent(result, 'app.resume', data)),
      ),
      onRaw('app.pause', (data) => this.update((result) => recordEvent(result, 'app.pause', data))),
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

  /**
   * Rows that run only on a button press: tap rows, and — when named in `?cases=` — the timeout
   * harness rows of gesture methods (native checks the gesture before it can time out).
   */
  readonly awaitsTap = (row: ConformanceCase): boolean =>
    row.trigger === 'tap' ||
    (this.explicit &&
      row.trigger === 'harness' &&
      row.category === 'timeout' &&
      needsGesture(row.method));

  /** Runs a button row on a real user click (the click is the gesture native checks). */
  tap(id: string): void {
    if (this.disposed || this.result.status !== 'done') return;
    const row = this.result.cases.find((candidate) => candidate.id === id);
    if (row === undefined || !this.awaitsTap(row)) return;
    void this.execute(row, false);
  }

  private stopAll: () => void = () => {};

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelGestureWait?.();
    for (const timer of this.watchdogs) clearTimeout(timer);
    this.watchdogs.clear();
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

  /**
   * `guarded`: the automatic run arms the watchdog so one silent call cannot stall the queue.
   * Button rows are not guarded: they block nothing, and their native flows (login, platform
   * authorisation, system dialogs) may legitimately take longer than the watchdog.
   */
  private async execute(row: ConformanceCase, guarded: boolean): Promise<void> {
    if (row.category === 'no_gesture') await this.waitForNoGesture();
    if (this.disposed) return;
    const since = performance.now();
    const call = probe(row.method, paramsForCase(row));
    const outcome = guarded ? await this.watch(call, row.method) : await call;
    this.update((result) => recordOutcome(result, row.id, outcome, elapsed(since)));
  }

  /** First of the reply and the watchdog wins; a reply after the watchdog is ignored. */
  private watch(call: Promise<CaseOutcome>, method: string): Promise<CaseOutcome> {
    const ms = (contractTimeoutMs(method) ?? 0) + CASE_WATCHDOG_MS;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.watchdogs.delete(timer);
        resolve(CASE_SILENT);
      }, ms);
      this.watchdogs.add(timer);
      void call.then((outcome) => {
        clearTimeout(timer);
        this.watchdogs.delete(timer);
        resolve(outcome);
      });
    });
  }

  /** Recheck after each wait: another real click restarts the native gesture window. */
  private async waitForNoGesture(): Promise<void> {
    while (!this.disposed && this.lastGestureAt !== null) {
      const remaining = NO_GESTURE_WAIT_MS - (performance.now() - this.lastGestureAt);
      if (remaining < 0) return;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          this.cancelGestureWait = null;
          resolve();
        };
        const timer = setTimeout(finish, Math.ceil(remaining) + 1);
        this.cancelGestureWait = finish;
      });
    }
  }

  /**
   * app.getEnv first, then one call at a time in table order, so native UI effects never
   * overlap. Loaded without `cases`: auto rows only; harness rows run only when named, except
   * those that wait for a button (awaitsTap).
   */
  private async runAll(): Promise<void> {
    const platform = await resolvePlatform();
    if (this.disposed) return;
    this.update((result) => replaceCases(result, casesForPlatform(this.selected, platform)));
    const runs = this.result.cases.filter(
      (row) =>
        row.id !== FRAME_CASE_ID &&
        !this.awaitsTap(row) &&
        (row.trigger === 'auto' || (this.explicit && row.trigger === 'harness')),
    );
    for (const row of runs) {
      if (this.disposed) return;
      await this.execute(row, true);
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
