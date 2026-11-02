// B1-08zh (D10-574, FU-PDD-NET-N): process-local counter couli_pdd_service_fee_missing_total, one
// increment per pdd report that lacks the service fee on an order that already has an estimate. It
// carries no amount and no order number. Skeleton only: the behaviour is pinned by
// test/spec/union/pdd-net-n/**.
export function countPddServiceFeeMissing(): void {
  throw new Error('NotImplemented: countPddServiceFeeMissing');
}
