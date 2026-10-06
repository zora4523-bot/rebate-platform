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

/** Hide the application behind the dialog (`inert` + `aria-hidden`); returns the undo. */
function isolate(root: HTMLElement | null): () => void {
  if (root === null) return () => {};
  const hadInert = root.hasAttribute('inert');
  const ariaHidden = root.getAttribute('aria-hidden');
  root.setAttribute('inert', '');
  root.setAttribute('aria-hidden', 'true');
  return () => {
    if (!hadInert) root.removeAttribute('inert');
    if (ariaHidden === null) root.removeAttribute('aria-hidden');
    else root.setAttribute('aria-hidden', ariaHidden);
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
  const copy = stepUpTexts[tier];
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [invalid, setInvalid] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [countdown, setCountdown] = useState(tier === 'sms' ? RESEND_INTERVAL_SECONDS : 0);

  const handleKeyDown = useEffectEvent((event: KeyboardEvent, panel: HTMLElement) => {
    if (event.key === 'Escape') {
      if (event.isComposing) return;
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    nextTabbable(panel, event.shiftKey)?.focus();
  });

  const applicationRoot = props.applicationRoot;
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    const active = document.activeElement;
    const previous = active instanceof HTMLElement && active !== document.body ? active : null;
    const undo = isolate(applicationRoot ?? document.getElementById('root'));
    titleRef.current?.focus();
    const listener = (event: KeyboardEvent) => handleKeyDown(event, panel);
    document.addEventListener('keydown', listener);
    return () => {
      document.removeEventListener('keydown', listener);
      // Lift the isolation first: an inert opener cannot take focus back.
      undo();
      restoreFocus(panel, previous);
    };
  }, [applicationRoot]);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  const complete = code.length === OTP_LENGTH;

  function handleChange(value: string): void {
    setCode(value);
    setInvalid(false);
  }

  function applyFailure(result: Extract<StepUpResult, { ok: false }>): void {
    if (result.code === ERROR_INCORRECT) {
      setError(stepUpTexts.errors.incorrect);
      setInvalid(true);
      setCode('');
      inputRef.current?.focus();
      return;
    }
    if (result.code === ERROR_EXPIRED && tier === 'sms') {
      setError(stepUpTexts.errors.expired);
      setCountdown(0);
      return;
    }
    if (result.code === ERROR_TOO_FREQUENT) {
      setError(stepUpTexts.errors.frequent);
      if (tier === 'sms') setCountdown(result.retryAfterSeconds ?? RESEND_INTERVAL_SECONDS);
      return;
    }
    setError(stepUpTexts.errors.generic);
  }

  async function submit(): Promise<void> {
    if (!complete || busyRef.current) return;
    busyRef.current = true;
    setSubmitting(true);
    setError(undefined);
    let result: StepUpResult;
    try {
      result = await onSubmit(code);
    } catch {
      result = { ok: false, code: 0 };
    } finally {
      busyRef.current = false;
      setSubmitting(false);
    }
    if (result.ok) onVerified(result.stepUpToken ?? '');
    else applyFailure(result);
  }

  async function resend(): Promise<void> {
    if (onResend === undefined || countdown > 0 || resending) return;
    setResending(true);
    setError(undefined);
    let result: StepUpResult;
    try {
      result = await onResend();
    } catch {
      result = { ok: false, code: 0 };
    } finally {
      setResending(false);
    }
    if (result.ok) setCountdown(RESEND_INTERVAL_SECONDS);
    else applyFailure(result);
  }

  return createPortal(
    <div className="step-up-layer">
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
            onClick={onClose}
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
          <button type="button" className="step-up-button step-up-button-default" onClick={onClose}>
            {stepUpTexts.cancel}
          </button>
          <button
            type="button"
            className="step-up-button step-up-button-primary"
            disabled={!complete}
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
