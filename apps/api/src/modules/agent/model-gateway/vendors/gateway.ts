import { VendorError } from './types.ts';
import type {
  DataClass,
  OfflineUse,
  OfflineVendorCall,
  VendorGateway,
  VendorGatewayOptions,
  VendorResponse,
  VendorUsage,
} from './types.ts';
import { assertOnlineVendor, registrationFor } from './registry.ts';
import { claimFailureUsage } from './billing.ts';

const OFFLINE_USES: readonly OfflineUse[] = [
  'eval_compare',
  'review_scoring',
  'prompt_rewrite',
  'synthetic_eval_gen',
];
const DATA_CLASSES: readonly DataClass[] = [
  'user_input',
  'production',
  'synthetic',
  'public_product',
  'prompt',
  'rewritten_sample',
  'owner_aggregate',
];

function checkOfflineData(call: OfflineVendorCall, options: VendorGatewayOptions): void {
  switch (call.dataClass) {
    case 'synthetic':
    case 'public_product':
    case 'prompt':
      return;
    case 'rewritten_sample': {
      const grants = options.rewrittenSampleGrants.filter(
        (grant) =>
          grant.vendor === call.vendor &&
          grant.accessPath === call.accessPath &&
          grant.workspace === call.workspace &&
          grant.model === call.model &&
          grant.use === call.use,
      );
      if (grants.length === 0) {
        throw new VendorError('rewritten_sample_not_allowed', 'No grant for this path and use');
      }
      const confirmed = grants.filter((grant) => grant.noTrainingConfirmed === true);
      if (confirmed.length === 0) {
        throw new VendorError('no_training_unconfirmed', 'No written no-training confirmation');
      }
      if (call.vendor !== 'qwen' && !confirmed.some((grant) => grant.legalApproved === true)) {
        throw new VendorError('legal_approval_missing', 'Legal approval is required');
      }
      return;
    }
    case 'owner_aggregate':
      if (
        call.vendor !== 'qwen' &&
        !options.ownerAggregateApprovals.some(
          (approval) =>
            approval.vendor === call.vendor &&
            typeof approval.approvalRecord === 'string' &&
            approval.approvalRecord.trim() !== '',
        )
      ) {
        throw new VendorError('owner_aggregate_not_approved', 'Owner approval is required');
      }
      return;
    default:
      throw new VendorError('data_class_not_allowed', 'Data class is not allowed offline');
  }
}

/** Options are trusted server configuration; never populate grants from a model or user body. */
export function createVendorGateway(input: VendorGatewayOptions): VendorGateway {
  const options: VendorGatewayOptions = {
    ...input,
    offlineBudgetApproved: [...input.offlineBudgetApproved],
    rewrittenSampleGrants: structuredClone(input.rewrittenSampleGrants),
    ownerAggregateApprovals: structuredClone(input.ownerAggregateApprovals),
  };
  return {
    async invoke(inputCall, signal) {
      if (signal?.aborted) throw new VendorError('aborted', 'Vendor call was cancelled');
      // Retain the authorized attribution across the asynchronous transport call.
      const call = { ...inputCall };
      const registration = registrationFor(call.vendor);
      if (!registration.purposes.includes(call.purpose)) {
        if (call.purpose === 'online') assertOnlineVendor(call.vendor);
        throw new VendorError('purpose_not_registered', 'Purpose is not registered');
      }
      if (typeof call.model !== 'string' || call.model.trim() === '') {
        throw new VendorError('purpose_not_registered', 'A model must be specified');
      }
      if (!DATA_CLASSES.includes(call.dataClass)) {
        throw new VendorError('data_class_not_allowed', 'Unknown data class');
      }
      const billable = options.transport.billable;
      if (call.purpose === 'online') {
        assertOnlineVendor(call.vendor);
      } else {
        if (
          !OFFLINE_USES.includes(call.use) ||
          !registration.accessPaths.includes(call.accessPath) ||
          typeof call.workspace !== 'string' ||
          call.workspace.trim() === ''
        ) {
          throw new VendorError('purpose_not_registered', 'Offline path or use is not registered');
        }
        checkOfflineData(call, options);
        if (
          billable &&
          registration.offlineBudgetRequired &&
          !options.offlineBudgetApproved.includes(call.vendor)
        ) {
          throw new VendorError('offline_budget_unset', 'Offline budget approval is required');
        }
      }
      const recordUsage = (usage: VendorUsage): void => {
        const meter = call.purpose === 'online' ? options.onlineMeter : options.offlineMeter;
        meter.record({
          vendor: call.vendor,
          purpose: call.purpose,
          use: call.purpose === 'offline' ? call.use : null,
          model: call.model,
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          recorded_at: options.clock.now(),
        });
      };
      let response: VendorResponse;
      try {
        response = await options.transport.send(
          { vendor: call.vendor, model: call.model, body: call.body },
          signal,
        );
      } catch (error) {
        if (billable) {
          const usage = claimFailureUsage(error);
          if (usage !== null) recordUsage(usage);
        }
        throw error;
      }
      if (billable) recordUsage(response.usage);
      return response;
    },
  };
}
