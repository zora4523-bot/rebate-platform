// 调等级 / 改上级 的写入流程：totp 二次验证（/admin/v1/auth/step-up）通过后，带 X-Step-Up-Token
// 只发一次写请求；10003（凭证失效）回到动态码，验证通过后用新凭证、原请求体再发；其余结果交回
// 对话框。在途时不接受第二次提交；对话框卸载后迟到的回答被丢弃。
import type { Schema } from '@couli/contracts-ts';
import { useDataProvider } from '@refinedev/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StepUpResult } from '../../../components/step-up/index.ts';
import { AdminApiError } from '../../../providers/data/index.ts';
import type { UserDetail } from '../model.ts';

const STEP_UP_URL = '/admin/v1/auth/step-up';
const STEP_UP_REFUSED = 10003;

export type WritePhase = 'idle' | 'verify' | 'sending';

export interface VerifiedWriteState {
  readonly phase: WritePhase;
  /** 上一次写入因凭证失效（10003）被拒，正在重新验证。 */
  readonly again: boolean;
}

export interface VerifiedWrite<TPayload> extends VerifiedWriteState {
  /** 开始一次提交：先弹动态码。已在验证或在途时忽略。 */
  start(payload: TPayload): void;
  /** 取消动态码（发送中不可取消）。 */
  cancel(): void;
  verify(code: string): Promise<StepUpResult>;
  onVerified(stepUpToken: string): void;
}

export interface VerifiedWriteOptions {
  readonly url: string;
  readonly onSaved: (user: UserDetail) => void;
  readonly onFailed: (cause: unknown) => void;
}

const IDLE: VerifiedWriteState = { phase: 'idle', again: false };

export function useVerifiedWrite<TPayload>({
  url,
  onSaved,
  onFailed,
}: VerifiedWriteOptions): VerifiedWrite<TPayload> {
  const getProvider = useDataProvider();
  const [state, setStateValue] = useState<VerifiedWriteState>(IDLE);
  const stateRef = useRef<VerifiedWriteState>(IDLE);
  const payloadRef = useRef<TPayload | undefined>(undefined);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const setState = useCallback((next: VerifiedWriteState) => {
    stateRef.current = next;
    setStateValue(next);
  }, []);

  const customOf = () => {
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    return custom;
  };

  const start = (payload: TPayload) => {
    if (stateRef.current.phase !== 'idle') return;
    payloadRef.current = payload;
    setState({ phase: 'verify', again: false });
  };

  const cancel = () => {
    if (stateRef.current.phase !== 'verify') return;
    setState(IDLE);
  };

  const verify = async (code: string): Promise<StepUpResult> => {
    const request: Schema<'AdminStepUpRequest'> = { tier: 'totp', code };
    try {
      const response = await customOf()<Schema<'AdminStepUpResponse'>['data']>({
        url: STEP_UP_URL,
        method: 'post',
        payload: request,
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

  const send = async (payload: TPayload, stepUpToken: string): Promise<void> => {
    try {
      const response = await customOf()<UserDetail>({
        url,
        method: 'post',
        payload,
        meta: { stepUpToken },
      });
      if (!alive.current) return;
      setState(IDLE);
      onSaved(response.data);
    } catch (cause) {
      if (!alive.current) return;
      if (cause instanceof AdminApiError && cause.code === STEP_UP_REFUSED) {
        // 凭证未被接受：重新验证（不重用旧凭证），验证通过后再发原请求体。
        setState({ phase: 'verify', again: true });
        return;
      }
      setState(IDLE);
      onFailed(cause);
    }
  };

  const onVerified = (stepUpToken: string) => {
    const payload = payloadRef.current;
    if (stateRef.current.phase !== 'verify' || payload === undefined) return;
    setState({ phase: 'sending', again: stateRef.current.again });
    void send(payload, stepUpToken);
  };

  return { ...state, start, cancel, verify, onVerified };
}
