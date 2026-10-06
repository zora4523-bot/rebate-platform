import type { ReactElement } from 'react';

export interface OtpInputProps {
  value: string;
  onChange(value: string): void;
  label: string;
  hint: string;
  autoFocus?: boolean;
  invalid?: boolean;
}

export function OtpInput(props: OtpInputProps): ReactElement {
  void props;
  throw new Error('NotImplemented: OtpInput');
}
