// identity's ports onto risk's SMS send risk (task B1-03g; 规划/08 BR-ID-05 细则「发码与设备注册的
// 风控默认值」): the 42901 step of the send order (deviceQuota, after the 44001 checks and before
// the per-phone quota), the landing page send's IP-only step
// (landingQuota, B1-11g; both reserve the IP send atomically, released when nothing went out), the
// counters after an accepted or unknown delivery (afterAccepted) and the
// new-account counter of the registration core (afterRegistered, every register_method, in the
// caller's transaction before commit).
// The device admission is keyed by device_hash, read here by (app_id, device_id); a device row
// that is missing or cannot be read answers 42901 with Retry-After 1 — never a fallback to the
// device id. A request without a client IP (an in-process send) skips only the IP items. No human verification: captcha_token is accepted by the route and ignored.
// Logs carry no phone and no IP (BR-ID-33), only flat fields.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators, no Nest.
import type { RootLogger } from '../../platform/index.ts';
import type { SmsRisk } from '../../risk/index.ts';
import type { RegistrationOptions } from './registration.ts';
import type { SmsHooks } from './sms-codes.ts';

/** identity owns the pooled lookup of devices by BOTH app_id and device_id. */
export interface SmsDeviceHashReader {
  deviceHashOf(appId: string, deviceId: string): Promise<string | null>;
}
export interface SmsRiskPorts {
  readonly smsHooks: Required<Pick<SmsHooks, 'deviceQuota' | 'landingQuota' | 'afterAccepted'>>;
  readonly registration: Required<Pick<RegistrationOptions, 'afterRegistered'>>;
}
export interface SmsRiskPortsOptions {
  /**
   * The reserving methods of B1-11g may be absent (a risk port built before it): landing sends
   * are then refused, and the app route falls back to the read-only admit() (counted by
   * afterAccepted's recordAccepted alone).
   */
  readonly risk: Omit<SmsRisk, ReservingMethods> & Partial<Pick<SmsRisk, ReservingMethods>>;
  readonly devices: SmsDeviceHashReader;
  readonly logger: RootLogger;
}

type ReservingMethods = 'admitIp' | 'admitAndReserve' | 'releaseIp';

/** Retry-After of a refusal whose device could not be resolved. */
const UNRESOLVED_RETRY_AFTER_SEC = 1;

function errorClass(error: unknown): string {
  if (error instanceof Error) return error.constructor.name || error.name;
  return error === null ? 'null' : typeof error;
}

export function createSmsRiskPorts(options: SmsRiskPortsOptions): SmsRiskPorts {
  const { risk, devices, logger } = options;
  const refused = { code: 42901, retryAfterSec: UNRESOLVED_RETRY_AFTER_SEC } as const;

  async function resolveHash(appId: string, deviceId: string | undefined): Promise<string | null> {
    if (deviceId === undefined) return null;
    try {
      return await devices.deviceHashOf(appId, deviceId);
    } catch (error) {
      logger.warn({ app_id: appId, error_class: errorClass(error) }, 'sms_device_hash_unreadable');
      return null;
    }
  }

  return {
    smsHooks: {
      async deviceQuota(request) {
        const appId = request.app_id;
        const deviceHash = await resolveHash(appId, request.device_id);
        if (deviceHash === null) {
          logger.info({ app_id: appId, purpose: request.purpose }, 'sms_device_unresolved');
          return { ...refused };
        }
        // The HTTP route always passes the client IP; an in-process send (no request behind it)
        // has none, so only the device admission judges it.
        const clientIp = request.client_ip;
        const input = {
          appId,
          deviceHash,
          phone: request.phone,
          ...(clientIp === undefined ? {} : { clientIp }),
        };
        const { admitAndReserve, releaseIp } = risk;
        if (admitAndReserve === undefined || releaseIp === undefined) {
          const admission = await risk.admit(input);
          return admission.code === 0
            ? null
            : { code: 42901, retryAfterSec: admission.retryAfterSec };
        }
        // B1-11g r2: the IP send is reserved atomically (shared with the landing page), so
        // concurrent sends from one IP cannot all pass a read of N < L.
        const admission = await admitAndReserve.call(risk, input);
        if (admission.code !== 0) {
          return { code: 42901, retryAfterSec: admission.retryAfterSec };
        }
        const { reservation } = admission;
        if (reservation === undefined || clientIp === undefined) return null;
        return {
          code: 0,
          reservation,
          release: () => releaseIp.call(risk, { appId, clientIp, reservation }),
        };
      },
      // B1-11g (BR-ID-32): the landing page send is judged by the two per-IP items only; it
      // always comes from an HTTP request, so a missing client IP is refused, never skipped.
      async landingQuota(request) {
        const appId = request.app_id;
        if (request.client_ip === undefined) {
          logger.warn({ app_id: appId, purpose: request.purpose }, 'sms_landing_ip_missing');
          return { ...refused };
        }
        const { admitIp, releaseIp } = risk;
        if (admitIp === undefined || releaseIp === undefined) {
          logger.error({ app_id: appId, purpose: request.purpose }, 'sms_landing_risk_missing');
          return { ...refused };
        }
        const clientIp = request.client_ip;
        // Atomic: judged and, when admitted, already counted for the IP (no read-then-record race).
        const admission = await admitIp.call(risk, { appId, clientIp });
        if (admission.code !== 0) {
          return { code: 42901, retryAfterSec: admission.retryAfterSec };
        }
        const { reservation } = admission;
        return {
          code: 0,
          reservation,
          release: () => releaseIp.call(risk, { appId, clientIp, reservation }),
        };
      },
      // With the send's reservation (app or landing) recordAccepted turns exactly that in-flight
      // record into the send's record at the provider's answer: nothing counted twice, no other
      // send's record touched.
      async afterAccepted(request, slot) {
        await risk.recordAccepted({
          appId: request.app_id,
          ...(request.client_ip === undefined ? {} : { clientIp: request.client_ip }),
          ...(slot == null || request.client_ip === undefined
            ? {}
            : { reservation: slot.reservation }),
        });
      },
    },
    registration: {
      async afterRegistered(_trx, input) {
        await risk.recordRegistered({
          appId: input.app_id,
          clientIp: input.client_ip,
          userId: input.user_id,
        });
      },
    },
  };
}
