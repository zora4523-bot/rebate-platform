// 本页写操作共用的动态码（totp 档）：每次写都先验证（契约 admin-unions：发起重新授权、录入新凭据、
// 增删告警手机号都要求 totp 档 X-Step-Up-Token），令牌只交给这一次写，不缓存、不复用。
import type { Schema } from '@couli/contracts-ts';
import { useDataProvider } from '@refinedev/core';
import { useCallback, useRef, useState, type ReactElement } from 'react';
import { StepUpModal, type StepUpResult } from '../../components/step-up/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { unionsTexts as t } from '../../texts/unions.ts';
import { STEP_UP_URL } from './model.ts';

export interface StepUpRequest {
  /** 「本次操作：」后面的说明。 */
  readonly operation: string;
  readonly details?: readonly string[];
  /** 上一次写被 10003 拒绝后再次验证。 */
  readonly again?: boolean;
  /** 拿到新令牌后执行这一次写。 */
  readonly run: (stepUpToken: string) => void;
  /** 取消验证（关闭动态码对话框）。 */
  readonly onCancel?: () => void;
}

export interface StepUp {
  ask(request: StepUpRequest): void;
  /**
   * 动态码对话框是否打开。打开期间本页的其他对话框先收起（组件与输入保留）：同一时间只显示一个
   * 对话框，可访问名与焦点都只属于动态码对话框。
   */
  readonly open: boolean;
  readonly modal: ReactElement;
}

export function useStepUp(): StepUp {
  const getProvider = useDataProvider();
  const requestRef = useRef<StepUpRequest | undefined>(undefined);
  const [current, setCurrent] = useState<StepUpRequest>();

  const ask = useCallback((request: StepUpRequest) => {
    requestRef.current = request;
    setCurrent(request);
  }, []);

  const verify = async (code: string): Promise<StepUpResult> => {
    const custom = getProvider().custom;
    if (custom === undefined) return { ok: false, code: 0 };
    const payload: Schema<'AdminStepUpRequest'> = { tier: 'totp', code };
    try {
      const response = await custom<Schema<'AdminStepUpResponse'>['data']>({
        url: STEP_UP_URL,
        method: 'post',
        payload,
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

  const onVerified = (stepUpToken: string) => {
    const request = requestRef.current;
    requestRef.current = undefined;
    setCurrent(undefined);
    request?.run(stepUpToken);
  };

  const onClose = () => {
    const request = requestRef.current;
    requestRef.current = undefined;
    setCurrent(undefined);
    request?.onCancel?.();
  };

  const modal = (
    <StepUpModal
      open={current !== undefined}
      tier="totp"
      operation={current?.operation ?? ''}
      details={[...(current?.details ?? []), ...(current?.again === true ? [t.stepUpAgain] : [])]}
      onSubmit={verify}
      onClose={onClose}
      onVerified={onVerified}
    />
  );
  return { ask, open: current !== undefined, modal };
}
