import type { ReactNode } from 'react';

export type StepUpTier = 'totp' | 'sms';

export type StepUpResult =
  { ok: true; stepUpToken?: string } | { ok: false; code: number; retryAfterSeconds?: number };

export interface StepUpModalProps {
  open: boolean;
  tier: StepUpTier;
  /** Operation name shown after「本次操作：」. */
  operation: string;
  /** Secondary description lines from the caller (object, audit note…). */
  details?: readonly string[];
  /** Masked verification phone; required for the SMS tier. */
  maskedPhone?: string;
  onSubmit(code: string): Promise<StepUpResult>;
  /** SMS tier: send a new code. Opening the dialog counts as the first send. */
  onResend?(): Promise<StepUpResult>;
  onClose(): void;
  onVerified(token: string): void;
  /** Made `inert` and `aria-hidden` while open; defaults to `#root`. */
  applicationRoot?: HTMLElement;
}

export interface StepUpGateProps {
  /** Step-up tier of the permission key; `null` when the action needs no step-up. */
  tier: StepUpTier | null;
  verifyPhoneRegistered: boolean;
  children: ReactNode;
  onAction(): void | Promise<void>;
  onRequestVerification(tier: StepUpTier): void;
  /** Server refusal of the last attempt (10003 + reason=verify_phone_missing blocks SMS actions). */
  failure?: { code: number; reason?: string };
  className?: string;
}
