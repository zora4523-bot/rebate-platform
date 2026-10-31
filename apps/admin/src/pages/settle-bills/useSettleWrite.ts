// 月结写操作的提交流程（契约 CT-24zd：每次都要 totp 动态码，X-Step-Up-Token）：提交先弹动态码，
// 验证通过后带新令牌只发一次写请求；10003（令牌失效）回到动态码，验证后用新令牌、原请求体（与原
// Idempotency-Key）再发；其余结果交回对话框。在途时不接受第二次提交；对话框卸载后迟到的回答被丢弃。
import type { Schema } from '@couli/contracts-ts';
import { useDataProvider, type BaseRecord } from '@refinedev/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StepUpResult } from '../../components/step-up/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';

const STEP_UP_URL = '/admin/v1/auth/step-up';
const STEP_UP_REFUSED = 10003;

/** One write: address, body and, for the supplement launch only, its Idempotency-Key. */
export interface SettleWriteRequest {
  readonly url: string;
  readonly payload: object;
  readonly idempotencyKey?: string;
}

export type SettleWritePhase = 'idle' | 'verify' | 'sending';

export interface SettleWrite {
  readonly phase: SettleWritePhase;
  /** The last write was refused for its step-up grant (10003): verifying again. */
  readonly again: boolean;
  /** Starts a submission: asks for the code first. Ignored while verifying or sending. */
  start(request: SettleWriteRequest): void;
  /** Closes the code dialog without writing (not while sending). */
  cancel(): void;
  verify(code: string): Promise<StepUpResult>;
  onVerified(stepUpToken: string): void;
}

export interface SettleWriteOptions<T extends BaseRecord> {
  readonly onDone: (data: T) => void;
  readonly onFailed: (cause: unknown) => void;
}

interface State {
  readonly phase: SettleWritePhase;
  readonly again: boolean;
}

const IDLE: State = { phase: 'idle', again: false };

export function useSettleWrite<T extends BaseRecord>({
  onDone,
  onFailed,
}: SettleWriteOptions<T>): SettleWrite {
  const getProvider = useDataProvider();
  const [state, setStateValue] = useState<State>(IDLE);
  const stateRef = useRef<State>(IDLE);
  const requestRef = useRef<SettleWriteRequest | undefined>(undefined);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const setState = useCallback((next: State) => {
    stateRef.current = next;
    setStateValue(next);
  }, []);

  const customOf = () => {
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    return custom;
  };

  const start = (request: SettleWriteRequest) => {
    if (stateRef.current.phase !== 'idle') return;
    requestRef.current = request;
    setState({ phase: 'verify', again: false });
  };

  const cancel = () => {
    if (stateRef.current.phase !== 'verify') return;
    setState(IDLE);
  };

  const verify = async (code: string): Promise<StepUpResult> => {
    const body: Schema<'AdminStepUpRequest'> = { tier: 'totp', code };
    try {
      const response = await customOf()<Schema<'AdminStepUpResponse'>['data']>({
        url: STEP_UP_URL,
        method: 'post',
        payload: body,
      });
      return { ok: true, stepUpToken: response.data.step_up_token };
    } catch (cause) {
      if (cause instanceof AdminApiError)
        return cause.retryAfterSeconds === undefined
          ? { ok: false, code: cause.code }
          : { ok: false, code: cause.code, retryAfterSeconds: cause.retryAfterSeconds };
      return { ok: false, code: 0 };
    }
  };

  const send = async (request: SettleWriteRequest, stepUpToken: string): Promise<void> => {
    try {
      const response = await customOf()<T>({
        url: request.url,
        method: 'post',
        payload: request.payload,
        meta: {
          stepUpToken,
          ...(request.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: request.idempotencyKey }),
        },
      });
      if (!alive.current) return;
      setState(IDLE);
      onDone(response.data);
    } catch (cause) {
      if (!alive.current) return;
      if (cause instanceof AdminApiError && cause.code === STEP_UP_REFUSED) {
        // The grant was not taken: verify again (never reuse it), then send the same request.
        setState({ phase: 'verify', again: true });
        return;
      }
      setState(IDLE);
      onFailed(cause);
    }
  };

  const onVerified = (stepUpToken: string) => {
    const request = requestRef.current;
    if (stateRef.current.phase !== 'verify' || request === undefined) return;
    setState({ phase: 'sending', again: stateRef.current.again });
    void send(request, stepUpToken);
  };

  return { ...state, start, cancel, verify, onVerified };
}
