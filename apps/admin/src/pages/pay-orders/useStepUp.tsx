// 【立即查询】的动态码（totp 档，契约 resolveAdminPayOrder 要求 totp 档 X-Step-Up-Token）：每次查询都先
// 验证，令牌只交给这一次写，不缓存、不复用。原路退款不走这里（不设二次验证，BR-PAY-06）。
import type { Schema } from '@couli/contracts-ts';
import { useDataProvider } from '@refinedev/core';
import { useCallback, useRef, useState, type ReactElement } from 'react';
import { StepUpModal, type StepUpResult } from '../../components/step-up/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { payOrdersTexts } from '../../texts/pay-orders.ts';

const STEP_UP_URL = '/admin/v1/auth/step-up';

export interface StepUpRequest {
  /** 「本次操作：」后面的说明。 */
  readonly operation: string;
  readonly details?: readonly string[];
  /** 上一次写被 10003 拒绝后再次验证。 */
  readonly again?: boolean;
  /** 拿到新令牌后执行这一次写。 */
  readonly run: (stepUpToken: string) => void;
}

export interface StepUp {
  ask(request: StepUpRequest): void;
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
    requestRef.current = undefined;
    setCurrent(undefined);
  };

  const modal = (
    <StepUpModal
      open={current !== undefined}
      tier="totp"
      operation={current?.operation ?? ''}
      details={[
        ...(current?.details ?? []),
        ...(current?.again === true ? [payOrdersTexts.resolve.stepUpAgain] : []),
      ]}
      onSubmit={verify}
      onClose={onClose}
      onVerified={onVerified}
    />
  );
  return { ask, open: current !== undefined, modal };
}
