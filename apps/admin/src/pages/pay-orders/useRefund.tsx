// 原路退款的提交流程（支付单详情与异常收款页签共用，BR-PAY-06）：打开对话框时生成 Idempotency-Key
// （经数据层 meta.idempotencyKey），同一对话框内重试沿用、重新打开换新；不带 X-Step-Up-Token。
// 20901 / 10403 之后本对话框不再提交，40901 与网络失败留在对话框里可重试；20902 与未找到关闭对话框，
// 由页面提示并重新读取；成功（PROCESSING）关闭对话框，交给页面提示并刷新。
// 网络失败、20901、40901 之后结果未知（服务端可能已建退款）：此后取消对话框时页面重新读取，
// 下一个对话框（新键）按最新的退款记录与可退金额预检。
import { useDataProvider } from '@refinedev/core';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { payOrdersTexts } from '../../texts/pay-orders.ts';
import {
  codeOf,
  isNetwork,
  newRequestKey,
  rejectedFields,
  type PayRefund,
  type PayRefundCreateRequest,
} from './model.ts';
import { RefundModal } from './RefundModal.tsx';

const t = payOrdersTexts.refund;

export interface RefundTarget {
  /** POST address of the refund. */
  readonly url: string;
  /** What is refunded (shown in the dialog). */
  readonly label: string;
  readonly refundable: bigint;
  readonly refundableNote: string;
}

export interface RefundHandlers {
  /** The refund was created (normally PROCESSING). */
  readonly onAccepted: (refund: PayRefund) => void;
  /** 20902: the target is no longer refundable as it was. */
  readonly onConflict: () => void;
  /** 20001 on the target id: unknown or no longer visible. */
  readonly onMissing: () => void;
  /** The dialog was cancelled after an unknown outcome (network failure, 20901, 40901). */
  readonly onUncertainClose: () => void;
}

interface Flow {
  /** One per opened dialog. */
  readonly dialog: number;
  readonly target: RefundTarget;
  readonly requestKey: string;
  readonly sending: boolean;
  readonly canSubmit: boolean;
  readonly amountRejected: number;
  /** A submit of this dialog may have created a refund the page does not show yet. */
  readonly uncertain: boolean;
  readonly error?: string;
}

export interface Refund {
  /** Opens a new refund dialog (a new Idempotency-Key). */
  start(target: RefundTarget): void;
  readonly open: boolean;
  readonly modal: ReactElement | null;
}

export function useRefund(handlers: RefundHandlers): Refund {
  const getProvider = useDataProvider();
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });
  const flowRef = useRef<Flow | undefined>(undefined);
  const [flow, setFlowState] = useState<Flow>();
  const dialogs = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const setFlow = (next: Flow | undefined) => {
    flowRef.current = next;
    setFlowState(next);
  };

  const start = (target: RefundTarget) => {
    if (flowRef.current !== undefined) return;
    dialogs.current += 1;
    setFlow({
      dialog: dialogs.current,
      target,
      requestKey: newRequestKey(),
      sending: false,
      canSubmit: true,
      amountRejected: 0,
      uncertain: false,
    });
  };

  const cancel = () => {
    const current = flowRef.current;
    if (current === undefined || current.sending) return;
    setFlow(undefined);
    if (current.uncertain) handlersRef.current.onUncertainClose();
  };

  const submit = async (body: PayRefundCreateRequest) => {
    const current = flowRef.current;
    if (current === undefined || current.sending || !current.canSubmit) return;
    // The dialog as it is, without the outcome of an earlier submit.
    const rest: Flow = {
      dialog: current.dialog,
      target: current.target,
      requestKey: current.requestKey,
      sending: false,
      canSubmit: current.canSubmit,
      amountRejected: current.amountRejected,
      uncertain: current.uncertain,
    };
    setFlow({ ...rest, sending: true });
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    try {
      const response = await custom<PayRefund>({
        url: current.target.url,
        method: 'post',
        payload: body,
        meta: { idempotencyKey: current.requestKey },
      });
      if (!alive.current) return;
      setFlow(undefined);
      handlersRef.current.onAccepted(response.data);
    } catch (cause) {
      if (!alive.current) return;
      const keep = (patch: Partial<Flow>) => setFlow({ ...rest, sending: false, ...patch });
      const code = codeOf(cause);
      const fields = rejectedFields(cause);
      if (code === 20001 && fields.includes('amount_fen')) {
        keep({ amountRejected: current.amountRejected + 1 });
      } else if (
        code === 20001 &&
        (fields.includes('pay_order_id') || fields.includes('pay_anomaly_id'))
      ) {
        setFlow(undefined);
        handlersRef.current.onMissing();
      } else if (code === 20902) {
        setFlow(undefined);
        handlersRef.current.onConflict();
      } else if (code === 20901) {
        // The same key with another body: never resent from this dialog.
        keep({ error: t.changed, canSubmit: false, uncertain: true });
      } else if (code === 40901) {
        keep({ error: t.running, uncertain: true });
      } else if (code === 10403) {
        keep({ error: t.forbidden, canSubmit: false });
      } else if (isNetwork(cause)) {
        // Not known whether it was created: a retry here resends the same key and body.
        keep({ error: t.network, uncertain: true });
      } else {
        keep({ error: t.failed });
      }
    }
  };

  const modal =
    flow === undefined ? null : (
      <RefundModal
        key={flow.dialog}
        target={flow.target.label}
        refundable={flow.target.refundable}
        refundableNote={flow.target.refundableNote}
        sending={flow.sending}
        amountRejected={flow.amountRejected}
        error={flow.error}
        canSubmit={flow.canSubmit}
        onCancel={cancel}
        onSubmit={(body) => void submit(body)}
      />
    );
  return { start, open: flow !== undefined, modal };
}
