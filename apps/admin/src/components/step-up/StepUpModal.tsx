import {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import { stepUpTexts } from '../../texts/step-up.ts';
import { OTP_LENGTH, OtpInput } from '../otp-input/index.ts';
import type { StepUpModalProps, StepUpResult } from './types.ts';
import './step-up.css';

/** Seconds before an SMS code may be requested again (design-hifi sample-data「验证码重发 60 秒」). */
export const RESEND_INTERVAL_SECONDS = 60;

/** Submit lock after 42901 when the response carries no usable Retry-After (08 §13.11). */
export const RETRY_AFTER_DEFAULT_SECONDS = 5;

const ERROR_INCORRECT = 20002;
const ERROR_EXPIRED = 20003;
const ERROR_TOO_FREQUENT = 42901;

const FOCUSABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]';

/** Tabbable controls inside the dialog in DOM order (disabled and negative tabindex skipped). */
function tabbables(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.tabIndex >= 0 && !element.matches(':disabled'),
  );
}

function nextTabbable(panel: HTMLElement, backwards: boolean): HTMLElement | undefined {
  const items = tabbables(panel);
  const active = document.activeElement;
  if (active === null || !panel.contains(active)) return backwards ? items.at(-1) : items[0];
  if (backwards) {
    const before = items.filter(
      (item) => item.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    return before.at(-1) ?? items.at(-1);
  }
  const after = items.find(
    (item) => active.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  return after ?? items[0];
}

/**
 * Give focus back to the opener. When the caller lifts its own `inert` in the same render that
 * unmounts the dialog, the browser can still refuse the focus during the cleanup, so retry after
 * the commit (microtask) and once more on the next frame (F1-01f review S1).
 */
function restoreFocus(panel: HTMLElement, previous: HTMLElement | null): void {
  if (previous === null) return;
  const attempt = (): boolean => {
    const active = document.activeElement;
    const lost = active === null || active === document.body || panel.contains(active);
    if (!previous.isConnected || !lost) return true;
    previous.focus();
    return document.activeElement === previous;
  };
  if (attempt()) return;
  queueMicrotask(() => {
    if (attempt()) return;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(attempt);
    else setTimeout(attempt, 0);
  });
}

/** Default monotonic clock: a wall-clock adjustment must not shorten a lock. */
function monotonicNow(): number {
  return performance.now();
}

/** Whole seconds left until `deadline` (clock ms) at `now`; 0 once it has passed. */
function secondsLeft(deadline: number, now: number): number {
  return deadline > now ? Math.ceil((deadline - now) / 1000) : 0;
}

/** Milliseconds until the displayed whole-second value of an active deadline next changes. */
function untilNextSecond(deadline: number, now: number): number | undefined {
  if (deadline <= now) return undefined;
  return (deadline - now) % 1000 || 1000;
}

/** Whole seconds from a Retry-After value; missing or unusable values fall back to `fallback`. */
function retryAfter(seconds: number | undefined, fallback: number): number {
  return seconds !== undefined && Number.isFinite(seconds) && seconds > 0
    ? Math.ceil(seconds)
    : fallback;
}

/**
 * Hide everything behind the dialog (`inert` + `aria-hidden`): every direct child of `body`
 * except the dialog's own layer — so antd Modal / Drawer portals underneath are isolated too —
 * plus the application root when it is nested deeper. Original values are restored on undo.
 */
function isolate(layer: HTMLElement, root: HTMLElement | null): () => void {
  const targets = new Set<HTMLElement>();
  for (const child of Array.from(document.body.children)) {
    if (child instanceof HTMLElement && child !== layer) targets.add(child);
  }
  if (root !== null && !root.contains(layer)) targets.add(root);
  const saved = Array.from(targets, (element) => ({
    element,
    inert: element.getAttribute('inert'),
    ariaHidden: element.getAttribute('aria-hidden'),
  }));
  for (const { element } of saved) {
    element.setAttribute('inert', '');
    element.setAttribute('aria-hidden', 'true');
  }
  return () => {
    for (const { element, inert, ariaHidden } of saved) {
      if (inert === null) element.removeAttribute('inert');
      else element.setAttribute('inert', inert);
      if (ariaHidden === null) element.removeAttribute('aria-hidden');
      else element.setAttribute('aria-hidden', ariaHidden);
    }
  };
}

function CloseIcon(): ReactElement {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

/**
 * Step-up verification dialog (规划/03 §9.2, BR-ID-34). It neither stores the token nor sends
 * requests: the caller verifies in `onSubmit` / `onResend` and closes it after `onVerified`.
 * Every opening starts afresh (empty code, no error, SMS countdown at 60).
 */
export function StepUpModal(props: StepUpModalProps): ReactElement | null {
  if (!props.open) return null;
  return <StepUpDialog {...props} />;
}

function StepUpDialog(props: StepUpModalProps): ReactElement {
  const { tier, operation, details, maskedPhone, onSubmit, onResend, onClose, onVerified } = props;
  const clock = props.clock ?? monotonicNow;
  const copy = stepUpTexts[tier];
  const titleId = useId();
  const descriptionId = useId();
  const layerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  // Bumped on every opening and closing; results of requests started under an older
  // generation are dropped (no onVerified, no state change).
  const generationRef = useRef(0);
  // Bumped on every successful resend. A 20003 from a submission made under an older send round
  // refers to a code that has already been replaced, so it must not expire the new one.
  const sendRoundRef = useRef(0);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [invalid, setInvalid] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  // Countdowns are kept as deadlines on a monotonic clock (ms) and recomputed on every tick, so
  // a throttled or sleeping machine does not stretch them and a wall-clock jump cannot cut them.
  const [now, setNow] = useState(clock);
  // Resend interval after a successful send (60 s): 20003 lifts it, 42901 replaces it.
  const [resendAt, setResendAt] = useState(() =>
    tier === 'sms' ? now + RESEND_INTERVAL_SECONDS * 1000 : 0,
  );
  // Server throttle from 42901 (Retry-After). Only ever extended: no later response shortens it.
  const [throttleAt, setThrottleAt] = useState(0);
  const [unlockAt, setUnlockAt] = useState(0);
  const countdown = secondsLeft(Math.max(resendAt, throttleAt), now);
  const submitLock = secondsLeft(unlockAt, now);

  function startInterval(seconds: number): void {
    const start = clock();
    setNow(start);
    setResendAt(seconds > 0 ? start + seconds * 1000 : 0);
  }

  function throttleResend(seconds: number): void {
    const start = clock();
    setNow(start);
    setResendAt(0);
    setThrottleAt((current) => Math.max(current, start + seconds * 1000));
  }

  function lockSubmit(seconds: number): void {
    const start = clock();
    setNow(start);
    setUnlockAt((current) => Math.max(current, start + seconds * 1000));
  }

  function dismiss(): void {
    generationRef.current += 1;
    busyRef.current = false;
    setSubmitting(false);
    setResending(false);
    onClose();
  }

  const handleKeyDown = useEffectEvent((event: KeyboardEvent, panel: HTMLElement) => {
    if (event.key === 'Escape') {
      if (event.isComposing) return;
      event.preventDefault();
      // Keep the Escape from reaching layers underneath (antd Modal / Drawer would close too).
      event.stopPropagation();
      dismiss();
      return;
    }
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    nextTabbable(panel, event.shiftKey)?.focus();
  });

  const applicationRoot = props.applicationRoot;
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const layer = layerRef.current;
    if (panel === null || layer === null) return;
    generationRef.current += 1;
    const active = document.activeElement;
    const previous = active instanceof HTMLElement && active !== document.body ? active : null;
    const undo = isolate(layer, applicationRoot ?? document.getElementById('root'));
    titleRef.current?.focus();
    const listener = (event: KeyboardEvent) => handleKeyDown(event, panel);
    // Capture on window so the dialog sees keys before any layer underneath.
    window.addEventListener('keydown', listener, true);
    return () => {
      generationRef.current += 1;
      window.removeEventListener('keydown', listener, true);
      // Lift the isolation first: an inert opener cannot take focus back.
      undo();
      restoreFocus(panel, previous);
    };
  }, [applicationRoot]);

  useEffect(() => {
    const delays = [
      untilNextSecond(Math.max(resendAt, throttleAt), now),
      untilNextSecond(unlockAt, now),
    ].filter((delay): delay is number => delay !== undefined);
    if (delays.length === 0) return;
    const timer = setTimeout(() => setNow(clock()), Math.min(...delays));
    return () => clearTimeout(timer);
  }, [resendAt, throttleAt, unlockAt, now, clock]);

  const complete = code.length === OTP_LENGTH;
  const canSubmit = complete && submitLock <= 0;

  function handleChange(value: string): void {
    setCode(value);
    setInvalid(false);
  }

  function applyFailure(
    result: Extract<StepUpResult, { ok: false }>,
    source: 'submit' | 'resend',
    sendRound: number,
  ): void {
    if (result.code === ERROR_INCORRECT) {
      setError(stepUpTexts.errors.incorrect);
      setInvalid(true);
      setCode('');
      inputRef.current?.focus();
      return;
    }
    if (result.code === ERROR_EXPIRED && tier === 'sms') {
      // A newer code was sent while this one was being checked: the expiry concerns the old
      // code only, so keep the new countdown and show the generic failure instead.
      if (sendRound !== sendRoundRef.current) {
        setError(stepUpTexts.errors.generic);
        return;
      }
      setError(stepUpTexts.errors.expired);
      // Lift the 60-second interval only; an active 42901 throttle stays in force.
      startInterval(0);
      return;
    }
    if (result.code === ERROR_TOO_FREQUENT) {
      // 08 §13.11: wait Retry-After seconds, 5 when it is missing (SMS resends included; the
      // 60-second interval applies only after a successful send).
      const seconds = retryAfter(result.retryAfterSeconds, RETRY_AFTER_DEFAULT_SECONDS);
      setError(stepUpTexts.errors.frequent);
      if (source === 'submit') lockSubmit(seconds);
      if (tier === 'sms') throttleResend(seconds);
      return;
    }
    setError(stepUpTexts.errors.generic);
  }

  async function submit(): Promise<void> {
    if (!canSubmit || busyRef.current) return;
    const generation = generationRef.current;
    const sendRound = sendRoundRef.current;
    busyRef.current = true;
    setSubmitting(true);
    setError(undefined);
    let result: StepUpResult;
    try {
      result = await onSubmit(code);
    } catch {
      result = { ok: false, code: 0 };
    }
    // Cancelled, closed or unmounted meanwhile: drop the stale result.
    if (generation !== generationRef.current) return;
    busyRef.current = false;
    setSubmitting(false);
    if (!result.ok) {
      applyFailure(result, 'submit', sendRound);
      return;
    }
    const token = result.stepUpToken;
    if (typeof token === 'string' && token !== '') onVerified(token);
    else setError(stepUpTexts.errors.generic);
  }

  async function resend(): Promise<void> {
    if (onResend === undefined || countdown > 0 || resending) return;
    const generation = generationRef.current;
    setResending(true);
    setError(undefined);
    let result: StepUpResult;
    try {
      result = await onResend();
    } catch {
      result = { ok: false, code: 0 };
    }
    if (generation !== generationRef.current) return;
    setResending(false);
    if (result.ok) {
      sendRoundRef.current += 1;
      startInterval(RESEND_INTERVAL_SECONDS);
    } else applyFailure(result, 'resend', sendRoundRef.current);
  }

  return createPortal(
    <div ref={layerRef} className="step-up-layer">
      <div className="step-up-backdrop" aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="step-up-dialog"
      >
        <div className="step-up-header">
          <h2 ref={titleRef} id={titleId} tabIndex={-1} className="step-up-title">
            {copy.title}
          </h2>
          <button
            type="button"
            aria-label={stepUpTexts.close}
            className="step-up-close"
            onClick={dismiss}
          >
            <CloseIcon />
          </button>
        </div>
        <div id={descriptionId} className="step-up-description">
          <div>
            {stepUpTexts.operationPrefix}
            <span className="step-up-operation">{operation}</span>
          </div>
          {(details ?? []).map((line, index) => (
            <div key={index} className="step-up-detail">
              {line}
            </div>
          ))}
          {tier === 'sms' ? (
            <div className="step-up-detail">{stepUpTexts.smsExplanation}</div>
          ) : null}
        </div>
        <div className="step-up-code">
          {tier === 'sms' ? (
            <div className="step-up-sent">
              <span>
                {stepUpTexts.smsSentTo}
                <span className="step-up-phone">{maskedPhone}</span>
              </span>
              <button
                type="button"
                className="step-up-resend"
                disabled={countdown > 0 || resending || onResend === undefined}
                onClick={() => void resend()}
              >
                {countdown > 0 ? stepUpTexts.resendCountdown(countdown) : stepUpTexts.resend}
              </button>
            </div>
          ) : null}
          <OtpInput
            value={code}
            onChange={handleChange}
            label={copy.label}
            hint={copy.hint}
            invalid={invalid}
            error={error}
            inputRef={inputRef}
            onEnter={() => void submit()}
          />
        </div>
        <div className="step-up-actions">
          <button type="button" className="step-up-button step-up-button-default" onClick={dismiss}>
            {stepUpTexts.cancel}
          </button>
          <button
            type="button"
            className="step-up-button step-up-button-primary"
            disabled={!canSubmit}
            aria-busy={submitting ? true : undefined}
            onClick={() => void submit()}
          >
            {submitting ? <span className="step-up-spinner" aria-hidden="true" /> : null}
            {stepUpTexts.submit}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
