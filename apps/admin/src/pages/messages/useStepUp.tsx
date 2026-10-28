// 本页写操作共用的动态码（totp 档，契约 CT-24t：开关、保存、测试发送、启用新配置每次都要 totp 档
// X-Step-Up-Token；放弃新配置不要）。
// 每次写都先验证，令牌只交给这一次写，不缓存、不复用。
import type { Schema } from '@couli/contracts-ts';
import { useDataProvider } from '@refinedev/core';
import { useCallback, useRef, useState, type ReactElement } from 'react';
import { StepUpModal, type StepUpResult } from '../../components/step-up/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { messagesTexts as t } from '../../texts/messages.ts';
import { STEP_UP_URL } from './model.ts';

export interface StepUpRequest {
  /** 「本次操作：」后面的说明。 */
  readonly operation: string;
  /** 上一次写被 10003 拒绝（令牌失效）后再次验证。 */
  readonly again?: boolean;
  /** 拿到新令牌后执行这一次写。 */
  readonly run: (stepUpToken: string) => void;
  /** 取消验证（关闭动态码对话框）。 */
  readonly onCancel?: () => void;
}

export interface StepUp {
  ask(request: StepUpRequest): void;
  readonly open: boolean;
  readonly modal: ReactElement | null;
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

  // 只在要验证时挂载：每次都新开在最上层（叠在抽屉与测试发送弹窗之上）。
  const modal =
    current === undefined ? null : (
      <StepUpModal
        open
        tier="totp"
        operation={current?.operation ?? ''}
        details={current?.again === true ? [t.stepUpAgain] : []}
        onSubmit={verify}
        onClose={onClose}
        onVerified={onVerified}
      />
    );
  return { ask, open: current !== undefined, modal };
}
