import {
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactElement,
  type Ref,
} from 'react';
import { Alert, Flex, Input, Typography, type InputRef } from 'antd';
import './otp-input.css';

export const OTP_LENGTH = 6;

export interface OtpInputProps {
  value: string;
  onChange(value: string): void;
  label: string;
  hint: string;
  autoFocus?: boolean;
  invalid?: boolean;
  /** Error line under the cells (antd Alert, `role=alert`), linked to the input with the hint. */
  error?: string | undefined;
  inputRef?: Ref<HTMLInputElement>;
  /** Enter pressed in the input (not while composing). */
  onEnter?(): void;
}

/** ASCII digits only, at most six (full-width and other scripts' digits are dropped). */
export function sanitizeOtp(raw: string): string {
  return raw.replace(/[^0-9]/g, '').slice(0, OTP_LENGTH);
}

/**
 * One antd Input (maxlength 6, numeric keypad, one-time-code autofill) laid transparently over
 * six decorative cells (规划/03 §9.1–9.2). Pasted text is cleaned before maxlength can cut it.
 */
export function OtpInput(props: OtpInputProps): ReactElement {
  const { value, onChange, label, hint, autoFocus, invalid, error, inputRef, onEnter } = props;
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const [focused, setFocused] = useState(false);
  const antdRef = useRef<InputRef>(null);
  // Callers keep a plain HTMLInputElement ref (focus after a wrong code).
  useImperativeHandle(inputRef, () => antdRef.current?.input as HTMLInputElement, []);
  const digits = sanitizeOtp(value);
  const active = Math.min(digits.length, OTP_LENGTH - 1);

  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    onChange(sanitizeOtp(event.target.value));
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>): void {
    const pasted = event.clipboardData.getData('text');
    event.preventDefault();
    const input = event.currentTarget;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    onChange(sanitizeOtp(input.value.slice(0, start) + pasted + input.value.slice(end)));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || onEnter === undefined) return;
    event.preventDefault();
    onEnter();
  }

  return (
    <Flex vertical align="center" gap="small" className="otp-input">
      <div className="otp-input-field">
        <label htmlFor={inputId} className="otp-input-label">
          {label}
        </label>
        <Flex gap="small" className="otp-input-cells" aria-hidden="true">
          {Array.from({ length: OTP_LENGTH }, (_, index) => (
            <span
              key={index}
              data-otp-cell=""
              className="otp-input-cell"
              data-active={focused && index === active ? '' : undefined}
              data-invalid={invalid ? '' : undefined}
            >
              {digits[index] ?? ''}
            </span>
          ))}
        </Flex>
        <Input
          ref={antdRef}
          id={inputId}
          className="otp-input-control"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={OTP_LENGTH}
          value={digits}
          autoFocus={autoFocus}
          status={invalid ? 'error' : ''}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={error === undefined ? hintId : `${errorId} ${hintId}`}
          onChange={handleChange}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
      </div>
      {error === undefined ? null : <Alert id={errorId} type="error" showIcon message={error} />}
      <Typography.Text id={hintId} type="secondary" className="otp-input-hint">
        {hint}
      </Typography.Text>
    </Flex>
  );
}
