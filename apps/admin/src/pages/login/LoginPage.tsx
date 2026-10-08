// Admin login pages (design-hifi AdmLogin, AdmLoginTotp, AdmLoginTotpBind, AdmLoginTotpBindInvalid,
// AdmLoginTotpBindDone; BR-ID-34). The step comes from the auth provider; each step moves focus to
// its title, errors use role=alert, and leaving the page discards the ticket and the binding
// secret. The change-password step has no artboard and reuses the AdmLogin layout.
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { OTP_LENGTH, OtpInput } from '../../components/otp-input/index.ts';
import type { AdminAuthProvider, LoginError, LoginSnapshot } from '../../providers/auth/index.ts';
import type { AdminEnvironment } from '../../shell-options.ts';
import { isLoginTextKey, loginText, type LoginTextKey } from '../../texts/login.ts';
import './login.css';

export interface LoginPageProps {
  readonly authProvider: AdminAuthProvider;
  readonly environment: AdminEnvironment;
  readonly onComplete: () => void;
}

const SHANGHAI = 'Asia/Shanghai';

/** BR-TEXT-11 future time: same year「MM-DD HH:mm」, otherwise「YYYY-MM-DD HH:mm」(+08:00). */
function formatFuture(iso: string, now: number): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  const parts = (value: number) => {
    const map = new Map(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: SHANGHAI,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(value)
        .map((part) => [part.type, part.value]),
    );
    return {
      year: map.get('year') ?? '',
      date: `${map.get('month') ?? ''}-${map.get('day') ?? ''}`,
      time: `${map.get('hour') ?? ''}:${map.get('minute') ?? ''}`,
    };
  };
  const target = parts(time);
  const date = target.year === parts(now).year ? target.date : `${target.year}-${target.date}`;
  return `${date} ${target.time}`;
}

/** The line to show for a failed step (BR-TEXT-14). */
export function loginErrorText(error: LoginError, now = Date.now()): string {
  if (error.key === 'error.10009' && error.lockedUntil !== undefined)
    return loginText('error.10009', { unlock_time: formatFuture(error.lockedUntil, now) });
  if (error.key === 'error.5xxxx') {
    return error.traceId === undefined || error.traceId === ''
      ? loginText('error.5xxxx.no_trace')
      : loginText('error.5xxxx', { trace6: error.traceId.slice(-6) });
  }
  if (isLoginTextKey(error.key)) {
    if (error.key === 'error.unknown' && error.serverMessage !== undefined)
      return error.serverMessage;
    return loginText(error.key);
  }
  return loginText('error.unknown');
}

function groupSecret(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? []).join(' ');
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}

/** Finished step in the step bar (AdmLoginTotp / AdmLoginTotpBind): a circled check. */
function StepDoneIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12.2 2.4 2.4 4.6-5" />
    </svg>
  );
}

function InfoIcon() {
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
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 7.8v.2" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v5.5M12 16.2v.2" />
    </svg>
  );
}

function UserIcon() {
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
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" />
    </svg>
  );
}

function EyeIcon({ open }: { readonly open: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.75" />
      {open ? null : <path d="m4 4 16 16" />}
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
    </svg>
  );
}

function SuccessIcon() {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12.2 2.4 2.4 4.6-4.8" />
    </svg>
  );
}

type View = 'credentials' | 'change_password' | 'totp' | 'bind_totp' | 'done';

interface StepItem {
  readonly label: string;
  readonly state: 'done' | 'current' | 'todo';
}

function Steps({ items }: { readonly items: readonly [StepItem, StepItem] }) {
  return (
    <ol className="login-steps" aria-label={loginText('steps.label')}>
      {items.map((item, index) => (
        <li
          key={index}
          className="login-step"
          data-state={item.state}
          aria-current={item.state === 'current' ? 'step' : undefined}
        >
          {index === 1 ? <span className="login-step-line" aria-hidden="true" /> : null}
          <span className="login-step-dot" aria-hidden="true">
            {item.state === 'done' ? <StepDoneIcon /> : index + 1}
          </span>
          <span className="login-step-label">{item.label}</span>
        </li>
      ))}
    </ol>
  );
}

interface FieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly type: 'text' | 'password';
  readonly autoComplete: string;
  readonly required?: boolean;
  readonly error?: string | undefined;
  readonly toggle?: boolean;
  readonly inputRef?: Ref<HTMLInputElement>;
}

function Field({
  label,
  value,
  onChange,
  type,
  autoComplete,
  required,
  error,
  toggle,
  inputRef,
}: FieldProps) {
  const id = useId();
  const errorId = useId();
  const [shown, setShown] = useState(false);
  return (
    <div className="login-field">
      <div className="login-field-label">
        {required ? (
          <span className="login-required" aria-hidden="true">
            *
          </span>
        ) : null}
        <label htmlFor={id}>{label}</label>
      </div>
      <div className="login-field-box" data-invalid={error === undefined ? undefined : ''}>
        <input
          id={id}
          ref={inputRef}
          className="login-field-input"
          type={type === 'password' && shown ? 'text' : type}
          value={value}
          autoComplete={autoComplete}
          required={required}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={error === undefined ? undefined : errorId}
          onChange={(event) => onChange(event.target.value)}
        />
        {toggle ? (
          <button
            type="button"
            className="login-field-toggle"
            aria-label={loginText(
              shown ? 'credentials.hide_password' : 'credentials.show_password',
            )}
            aria-pressed={shown}
            onClick={() => setShown((value) => !value)}
          >
            <EyeIcon open={shown} />
          </button>
        ) : null}
      </div>
      {error === undefined ? null : (
        <div id={errorId} className="login-field-error">
          {error}
        </div>
      )}
    </div>
  );
}

function ErrorBanner({ text }: { readonly text: string }) {
  return (
    <div role="alert" className="login-banner login-banner-error">
      <span className="login-banner-icon">
        <AlertIcon />
      </span>
      <div className="login-banner-body">{text}</div>
    </div>
  );
}

/** 42901: submit stays disabled for Retry-After seconds (default 5) from the error's arrival. */
function useCooldown(error: LoginError | undefined): boolean {
  const [cooled, setCooled] = useState<LoginError | undefined>(undefined);
  useEffect(() => {
    const seconds = error?.retryAfterSeconds;
    if (error === undefined || seconds === undefined) return undefined;
    const timer = setTimeout(() => setCooled(error), seconds * 1000);
    return () => clearTimeout(timer);
  }, [error]);
  return error?.retryAfterSeconds !== undefined && cooled !== error;
}

type FieldCheck = readonly [RefObject<HTMLInputElement | null>, boolean];

function isCodeError(error: LoginError | undefined): boolean {
  return error?.key.startsWith('error.20002') === true;
}

export function LoginPage({ authProvider, environment, onComplete }: LoginPageProps): ReactElement {
  const snapshot: LoginSnapshot = useSyncExternalStore(
    authProvider.subscribe,
    authProvider.getSnapshot,
    authProvider.getSnapshot,
  );
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  // A wrong code (20002) empties the cells in the same render that shows the error; digits typed
  // after that error are kept.
  const [codeState, setCodeState] = useState<{
    readonly value: string;
    readonly seenError: LoginError | undefined;
  }>({ value: '', seenError: undefined });
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const [copied, setCopied] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const newPasswordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const cooling = useCooldown(snapshot.error);
  const code =
    codeState.seenError !== snapshot.error && isCodeError(snapshot.error) ? '' : codeState.value;
  const setCode = (value: string): void =>
    setCodeState({ value, seenError: authProvider.getSnapshot().error });

  // A dynamic-code login stays on its page until the shell takes over; a binding shows its done
  // page. Both come from the same provider update, so no step flashes in between.
  const view: View =
    snapshot.step === 'done' ? (snapshot.bound === true ? 'done' : 'totp') : snapshot.step;

  // 20001: the fields the server named (data.fields) are marked beside their inputs.
  const serverFields = new Set(snapshot.error?.fields ?? []);
  const fieldError = (local: string | undefined, ...names: string[]): string | undefined =>
    local ??
    (names.some((name) => serverFields.has(name)) ? loginText('field.invalid') : undefined);

  // Leaving the page (route change, unmount) voids the ticket and the binding secret.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      authProvider.resetLogin();
    };
  }, [authProvider]);

  // Each step announces itself by moving focus to its title.
  useEffect(() => {
    headingRef.current?.focus();
  }, [view]);

  // A step change starts with empty inputs (the secret is never kept beyond its step).
  const [shownView, setShownView] = useState(view);
  if (shownView !== view) {
    setShownView(view);
    setCodeState({ value: '', seenError: undefined });
    setCopied(false);
    setFieldErrors({});
    if (view === 'credentials') setPassword('');
    if (view !== 'change_password') {
      setNewPassword('');
      setConfirmPassword('');
    }
  }

  async function run(work: () => ReturnType<AdminAuthProvider['login']>): Promise<boolean> {
    setSubmitting(true);
    try {
      const result = await work();
      return result.success;
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  }

  /** Moves focus to the first field named by a local check or by the server (20001). */
  function focusFirst(fields: readonly FieldCheck[]): void {
    for (const [ref, invalid] of fields) {
      if (invalid) {
        ref.current?.focus();
        return;
      }
    }
  }

  function rejectedFields(): Set<string> {
    return new Set(authProvider.getSnapshot().error?.fields ?? []);
  }

  async function submitCredentials(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (submitting || cooling) return;
    const errors: Record<string, string> = {};
    if (username.trim() === '') errors['username'] = loginText('field.username_required');
    if (password === '') errors['password'] = loginText('field.password_required');
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      focusFirst([
        [usernameRef, errors['username'] !== undefined],
        [passwordRef, errors['password'] !== undefined],
      ]);
      return;
    }
    const ok = await run(() =>
      authProvider.login({ step: 'credentials', username: username.trim(), password }),
    );
    if (ok || !mounted.current) return;
    const rejected = rejectedFields();
    focusFirst([
      [usernameRef, rejected.has('username')],
      [passwordRef, rejected.has('password')],
    ]);
  }

  async function submitPassword(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (submitting || cooling) return;
    const errors: Record<string, string> = {};
    if (newPassword === '') errors['newPassword'] = loginText('password.new_required');
    else if (confirmPassword !== newPassword) errors['confirm'] = loginText('password.mismatch');
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      focusFirst([
        [newPasswordRef, errors['newPassword'] !== undefined],
        [confirmRef, errors['confirm'] !== undefined],
      ]);
      return;
    }
    const ok = await run(() => authProvider.login({ step: 'change_password', newPassword }));
    if (ok || !mounted.current) return;
    focusFirst([[newPasswordRef, rejectedFields().has('new_password')]]);
  }

  async function submitCode(step: 'totp' | 'bind_totp'): Promise<void> {
    if (submitting || cooling || code.length !== OTP_LENGTH) return;
    const ok = await run(() => authProvider.login({ step, code }));
    if (!mounted.current) return;
    if (ok) {
      // A binding shows its done page first (「进入后台」); a dynamic code enters directly.
      if (step === 'totp') onComplete();
      return;
    }
    const error = authProvider.getSnapshot().error;
    if (isCodeError(error) || error?.fields?.includes('code') === true) codeRef.current?.focus();
  }

  function enter(): void {
    // The session may have ended while the done page waited; the provider then shows step one.
    if (authProvider.getToken() !== null) onComplete();
  }

  function backToStart(keepUsername: boolean): void {
    authProvider.resetLogin();
    if (!keepUsername) setUsername('');
    setPassword('');
  }

  async function copySecret(secret: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(secret);
      if (mounted.current) setCopied(true);
    } catch {
      // Clipboard refused: the grouped secret stays on screen for manual entry.
    }
  }

  const errorText = snapshot.error === undefined ? undefined : loginErrorText(snapshot.error);
  const blocked = submitting || cooling;
  const codeInvalid = isCodeError(snapshot.error) || serverFields.has('code');

  let subtitle: ReactNode = null;
  let titleKey: LoginTextKey = 'credentials.title';
  let body: ReactNode = null;
  let wide = false;

  const credentialsDone: StepItem = { label: loginText('steps.credentials'), state: 'done' };

  switch (view) {
    case 'credentials':
      titleKey = 'credentials.title';
      body = (
        <form className="login-form" noValidate onSubmit={(event) => void submitCredentials(event)}>
          <Steps
            items={[
              { label: loginText('steps.credentials'), state: 'current' },
              { label: loginText('steps.totp'), state: 'todo' },
            ]}
          />
          <div className="login-fields">
            <Field
              label={loginText('credentials.username')}
              value={username}
              onChange={setUsername}
              type="text"
              autoComplete="username"
              required
              inputRef={usernameRef}
              error={fieldError(fieldErrors['username'], 'username')}
            />
            <Field
              label={loginText('credentials.password')}
              value={password}
              onChange={setPassword}
              type="password"
              autoComplete="current-password"
              required
              toggle
              inputRef={passwordRef}
              error={fieldError(fieldErrors['password'], 'password')}
            />
          </div>
          {errorText === undefined ? null : <ErrorBanner text={errorText} />}
          <button type="submit" className="login-button-primary" disabled={blocked}>
            {loginText('next')}
          </button>
          <div className="login-banner login-banner-info">
            <span className="login-banner-icon">
              <InfoIcon />
            </span>
            <div className="login-banner-body">{loginText('credentials.note')}</div>
          </div>
        </form>
      );
      break;

    case 'change_password':
      titleKey = 'password.title';
      body = (
        <form className="login-form" noValidate onSubmit={(event) => void submitPassword(event)}>
          <Steps
            items={[credentialsDone, { label: loginText('password.step'), state: 'current' }]}
          />
          <AccountRow username={snapshot.username} onSwitch={() => backToStart(false)} />
          <div className="login-banner login-banner-info">
            <span className="login-banner-icon">
              <InfoIcon />
            </span>
            <div className="login-banner-body">{loginText('password.intro')}</div>
          </div>
          <div className="login-fields">
            <Field
              label={loginText('password.new')}
              value={newPassword}
              onChange={setNewPassword}
              type="password"
              autoComplete="new-password"
              inputRef={newPasswordRef}
              error={fieldError(fieldErrors['newPassword'], 'new_password')}
            />
            <Field
              label={loginText('password.confirm')}
              value={confirmPassword}
              onChange={setConfirmPassword}
              type="password"
              autoComplete="new-password"
              inputRef={confirmRef}
              error={fieldErrors['confirm']}
            />
          </div>
          {errorText === undefined ? null : <ErrorBanner text={errorText} />}
          <button type="submit" className="login-button-primary" disabled={blocked}>
            {loginText('next')}
          </button>
          <div className="login-links">
            <button type="button" className="login-link" onClick={() => backToStart(true)}>
              {loginText('back')}
            </button>
          </div>
        </form>
      );
      break;

    case 'totp':
      titleKey = 'totp.title';
      body = (
        <form
          className="login-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submitCode('totp');
          }}
        >
          <Steps items={[credentialsDone, { label: loginText('steps.totp'), state: 'current' }]} />
          <AccountRow username={snapshot.username} onSwitch={() => backToStart(false)} />
          <OtpInput
            value={code}
            onChange={setCode}
            label={loginText('totp.label')}
            hint={loginText('totp.hint')}
            invalid={codeInvalid}
            error={errorText}
            inputRef={codeRef}
            onEnter={() => void submitCode('totp')}
          />
          <button
            type="submit"
            className="login-button-primary"
            disabled={blocked || code.length !== OTP_LENGTH}
          >
            {loginText('totp.submit')}
          </button>
          <div className="login-links">
            <button type="button" className="login-link" onClick={() => backToStart(true)}>
              {loginText('back')}
            </button>
            <span className="login-caption">{loginText('totp.help')}</span>
          </div>
        </form>
      );
      break;

    case 'bind_totp': {
      wide = true;
      titleKey = 'bind.title';
      const secret = snapshot.secret;
      const invalid = isCodeError(snapshot.error);
      // The secret could not be fetched: the ticket is kept, only the secret is asked again.
      const secretFailed =
        secret === undefined && snapshot.secretLoading !== true && snapshot.error !== undefined;
      body = (
        <form
          className="login-form login-form-bind"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submitCode('bind_totp');
          }}
        >
          <Steps items={[credentialsDone, { label: loginText('steps.bind'), state: 'current' }]} />
          <AccountRow
            username={snapshot.username}
            tag={loginText('bind.pending_tag')}
            onSwitch={() => backToStart(false)}
          />
          {invalid ? (
            <div className="login-banner login-banner-error">
              <span className="login-banner-icon">
                <AlertIcon />
              </span>
              <div className="login-banner-body login-banner-stack">
                <span className="login-strong">{loginText('bind.invalid_title')}</span>
                <span className="login-primary-text">{loginText('bind.invalid_desc')}</span>
              </div>
            </div>
          ) : (
            <div className="login-banner login-banner-info">
              <span className="login-banner-icon">
                <InfoIcon />
              </span>
              <div className="login-banner-body">{loginText('bind.intro')}</div>
            </div>
          )}
          {secretFailed && errorText !== undefined ? <ErrorBanner text={errorText} /> : null}
          <div className="login-bind-step">
            <span className="login-bind-number" aria-hidden="true">
              1
            </span>
            <div className="login-banner-stack">
              <span className="login-strong">{loginText('bind.step1')}</span>
              <span className="login-caption">{loginText('bind.step1_hint')}</span>
            </div>
          </div>
          <div className="login-bind-section">
            <div className="login-bind-step">
              <span className="login-bind-number" aria-hidden="true">
                2
              </span>
              <span className="login-strong">{loginText('bind.step2')}</span>
            </div>
            <div className="login-bind-detail login-bind-qr-row">
              <div className="login-qr" role="img" aria-label={loginText('bind.qr_label')}>
                <span>{loginText('bind.qr_line1')}</span>
                <span>{loginText('bind.qr_line2')}</span>
                <span>{loginText('bind.qr_line3')}</span>
              </div>
              <div className="login-bind-manual">
                <div className="login-caption">{loginText('bind.manual')}</div>
                <div className="login-banner-stack">
                  <span className="login-caption">{loginText('bind.account_label')}</span>
                  <span>{loginText('bind.account_value', { username: snapshot.username })}</span>
                </div>
                <div className="login-banner-stack">
                  <span className="login-caption">{loginText('bind.secret_label')}</span>
                  <span className="login-secret">
                    {secret !== undefined
                      ? groupSecret(secret.totp_secret)
                      : snapshot.secretLoading === true
                        ? loginText('bind.secret_loading')
                        : ''}
                  </span>
                </div>
                {secretFailed ? (
                  <button
                    type="button"
                    className="login-link"
                    disabled={blocked}
                    onClick={() => void authProvider.retryBindingSecret()}
                  >
                    {loginText('bind.secret_retry')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="login-link"
                    disabled={secret === undefined}
                    onClick={() => {
                      if (secret !== undefined) void copySecret(secret.totp_secret);
                    }}
                  >
                    <CopyIcon />
                    {loginText('bind.copy')}
                  </button>
                )}
                <span className="login-caption" role="status">
                  {copied ? loginText('bind.copied') : ''}
                </span>
                <div className="login-caption">{loginText('bind.type')}</div>
              </div>
            </div>
          </div>
          <div className="login-bind-section">
            <div className="login-bind-step">
              <span className="login-bind-number" aria-hidden="true">
                3
              </span>
              <span className="login-strong">{loginText('bind.step3')}</span>
            </div>
            <div className="login-bind-detail login-bind-code">
              <OtpInput
                value={code}
                onChange={setCode}
                label={loginText('bind.label')}
                hint={loginText('bind.hint')}
                invalid={codeInvalid}
                error={secretFailed ? undefined : errorText}
                inputRef={codeRef}
                onEnter={() => void submitCode('bind_totp')}
              />
            </div>
          </div>
          <button
            type="submit"
            className="login-button-primary"
            disabled={blocked || code.length !== OTP_LENGTH || secret === undefined}
          >
            {loginText('bind.submit')}
          </button>
          <div className="login-links">
            <button type="button" className="login-link" onClick={() => backToStart(true)}>
              {loginText('back')}
            </button>
            <span className="login-caption">{loginText('bind.help')}</span>
          </div>
          <div className="login-bind-note">{loginText('bind.leave_note')}</div>
        </form>
      );
      break;
    }

    case 'done':
      wide = true;
      titleKey = 'done.title';
      subtitle = <div className="login-subtitle">{loginText('done.subtitle')}</div>;
      break;
  }

  const title = (
    <h1
      ref={headingRef}
      tabIndex={-1}
      className={view === 'done' ? 'login-done-title' : 'login-subtitle'}
    >
      {loginText(titleKey)}
    </h1>
  );

  if (view === 'done') {
    body = (
      <div className="login-form login-form-bind">
        <Steps items={[credentialsDone, { label: loginText('steps.bind'), state: 'done' }]} />
        <AccountRow username={snapshot.username} tag={loginText('done.bound_tag')} tagDone />
        <div className="login-done-box">
          <span className="login-done-icon">
            <SuccessIcon />
          </span>
          {title}
          <div>{loginText('done.desc', { username: snapshot.username })}</div>
        </div>
        <div className="login-landing">
          <span className="login-strong">{loginText('done.landing_title')}</span>
          <div className="login-landing-item">
            <span className="login-caption-dot" aria-hidden="true">
              ·
            </span>
            <span>{loginText('done.landing_with')}</span>
          </div>
          <div className="login-landing-item">
            <span className="login-caption-dot" aria-hidden="true">
              ·
            </span>
            <span>{loginText('done.landing_without')}</span>
          </div>
        </div>
        <button type="button" className="login-button-primary" onClick={enter}>
          {loginText('done.enter')}
        </button>
        <div className="login-caption login-center">{loginText('done.lost')}</div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-column">
        <section className="login-card" data-wide={wide ? '' : undefined}>
          <div className="login-head">
            <div className="login-logo" aria-hidden="true">
              {loginText('brand.logo')}
            </div>
            <div className="login-head-text">
              <div className="login-brand">{loginText('brand')}</div>
              {view === 'done' ? subtitle : title}
            </div>
          </div>
          {body}
        </section>
        <div className="login-footer">{loginText('footer')}</div>
      </div>
      {environment === 'production' ? null : (
        <div className="login-env">
          <span className="login-env-tag">{loginText('env.test')}</span>
        </div>
      )}
    </div>
  );
}

interface AccountRowProps {
  readonly username: string;
  readonly tag?: string;
  readonly tagDone?: boolean;
  readonly onSwitch?: () => void;
}

function AccountRow({ username, tag, tagDone, onSwitch }: AccountRowProps) {
  return (
    <div className="login-account">
      <div className="login-account-info">
        <span className="login-account-icon">
          <UserIcon />
        </span>
        <span>{username}</span>
        {tag === undefined ? null : (
          <span className="login-tag" data-done={tagDone ? '' : undefined}>
            {tagDone ? <CheckIcon /> : null}
            {tag}
          </span>
        )}
      </div>
      {onSwitch === undefined ? null : (
        <button type="button" className="login-link" onClick={onSwitch}>
          {loginText('switch_account')}
        </button>
      )}
    </div>
  );
}
