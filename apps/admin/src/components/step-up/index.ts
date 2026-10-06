import type { ReactElement, ReactNode } from 'react';

export type StepUpTier = 'totp' | 'sms';

export type StepUpResult =
  { ok: true; stepUpToken?: string } | { ok: false; code: number; retryAfterSeconds?: number };

export interface StepUpModalProps {
  open: boolean;
  tier: StepUpTier;
  operation: string;
  details?: readonly string[];
  maskedPhone?: string;
  onSubmit(code: string): Promise<StepUpResult>;
  onResend?(): Promise<StepUpResult>;
  onClose(): void;
  onVerified(token: string): void;
  applicationRoot?: HTMLElement;
}

export interface StepUpGateProps {
  tier: StepUpTier | null;
  verifyPhoneRegistered: boolean;
  children: ReactNode;
  onAction(): void | Promise<void>;
  onRequestVerification(tier: StepUpTier): void;
  failure?: { code: number; reason?: string };
}

export function StepUpModal(props: StepUpModalProps): ReactElement | null {
  void props;
  throw new Error('NotImplemented: StepUpModal');
}

export function StepUpGate(props: StepUpGateProps): ReactElement {
  void props;
  throw new Error('NotImplemented: StepUpGate');
}
