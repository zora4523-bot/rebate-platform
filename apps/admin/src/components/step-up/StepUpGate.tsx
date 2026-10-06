import { useId, type ReactElement } from 'react';
import { stepUpTexts } from '../../texts/step-up.ts';
import type { StepUpGateProps, StepUpTier } from './types.ts';
import './step-up.css';

const ERROR_FORBIDDEN = 10003;
const VERIFY_PHONE_MISSING = 'verify_phone_missing';

export interface StepUpActionState {
  /** True when the action cannot run: SMS tier without a registered verification phone. */
  blocked: boolean;
  /** Text to show and link with `aria-describedby` while blocked. */
  reason?: string;
}

/**
 * Whether an action guarded by step-up can start (规划/03 §9.2, BR-ID-34): SMS-tier actions need
 * a registered verification phone; the server answer 10003 + verify_phone_missing means the same.
 */
export function useStepUpAction(options: {
  tier: StepUpTier | null;
  verifyPhoneRegistered: boolean;
  failure?: { code: number; reason?: string };
}): StepUpActionState {
  const { tier, verifyPhoneRegistered, failure } = options;
  const refused = failure?.code === ERROR_FORBIDDEN && failure.reason === VERIFY_PHONE_MISSING;
  const blocked = refused || (tier === 'sms' && !verifyPhoneRegistered);
  return blocked ? { blocked, reason: stepUpTexts.verifyPhoneMissing } : { blocked };
}

/**
 * Trigger button for an action that may need step-up. A blocked action stays focusable
 * (`aria-disabled`) with the reason linked; otherwise it asks for verification of its tier or,
 * without a tier, runs directly.
 */
export function StepUpGate(props: StepUpGateProps): ReactElement {
  const { tier, children, onAction, onRequestVerification, className } = props;
  const state = useStepUpAction(props);
  const reasonId = useId();

  function handleClick(): void {
    if (state.blocked) return;
    if (tier === null) void onAction();
    else onRequestVerification(tier);
  }

  return (
    <span className="step-up-gate">
      <button
        type="button"
        className={className ?? 'step-up-button step-up-button-primary'}
        aria-disabled={state.blocked ? true : undefined}
        aria-describedby={state.blocked ? reasonId : undefined}
        onClick={handleClick}
      >
        {children}
      </button>
      {state.blocked ? (
        <span id={reasonId} className="step-up-gate-reason">
          {state.reason}
        </span>
      ) : null}
    </span>
  );
}
