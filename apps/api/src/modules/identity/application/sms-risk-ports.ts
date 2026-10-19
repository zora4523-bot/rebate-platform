// identity's ports onto risk's SMS send risk (task B1-03g; 规划/08 BR-ID-05 细则「发码与设备注册的
// 风控默认值」): the 42901 step of the send order (deviceQuota, after the 44001 checks and before
// the per-phone quota), the landing page send's IP-only step
// (landingQuota, B1-11g round 7: both judge the IP's items read-only through risk.checkAttempts and
// hand back a gate whose commit is risk.admitAttempt, the binding count under the IP's lock, and
// whose slot writes the outcome), the counters after an accepted or unknown delivery (afterAccepted) and the
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
import type { SmsAttemptGate, SmsHooks } from './sms-codes.ts';

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
   * The attempt methods of B1-11g may be absent (a risk port built before it): landing sends are
   * then refused, and the app route falls back to the read-only admit().
   */
  readonly risk: Omit<SmsRisk, AttemptMethods> & Partial<Pick<SmsRisk, AttemptMethods>>;
  readonly devices: SmsDeviceHashReader;
  readonly logger: RootLogger;
}

type AttemptMethods = 'checkAttempts' | 'admitAttempt' | 'admitDevice' | 'finishAttempt';
type AttemptPort = Required<Pick<SmsRisk, AttemptMethods>>;

/** Retry-After of a refusal whose device could not be resolved. */
const UNRESOLVED_RETRY_AFTER_SEC = 1;

function errorClass(error: unknown): string {
  if (error instanceof Error) return error.constructor.name || error.name;
  return error === null ? 'null' : typeof error;
}

export function createSmsRiskPorts(options: SmsRiskPortsOptions): SmsRiskPorts {
  const { risk, devices, logger } = options;
  const refused = { code: 42901, retryAfterSec: UNRESOLVED_RETRY_AFTER_SEC } as const;

  /** The risk port's attempt methods, or null for a port built before B1-11g. */
  function attemptPort(): AttemptPort | null {
    const { checkAttempts, admitAttempt, admitDevice, finishAttempt } = risk;
    if (
      checkAttempts === undefined ||
      admitAttempt === undefined ||
      admitDevice === undefined ||
      finishAttempt === undefined
    ) {
      return null;
    }
    return {
      checkAttempts: (input) => checkAttempts.call(risk, input),
      admitAttempt: (input) => admitAttempt.call(risk, input),
      admitDevice: (input) => admitDevice.call(risk, input),
      finishAttempt: (input) => finishAttempt.call(risk, input),
    };
  }

  /** The gate of a send whose IP items passed: commit = the binding attempt. */
  function attemptGate(
    port: AttemptPort,
    appId: string,
    clientIp: string,
    phone: string,
  ): SmsAttemptGate {
    return {
      code: 0,
      async commit() {
        const attempt = await port.admitAttempt({ appId, clientIp, phone });
        if (attempt.code !== 0) return { code: 42901, retryAfterSec: attempt.retryAfterSec };
        const { attemptId } = attempt;
        return {
          code: 0,
          finish: (outcome) => port.finishAttempt({ appId, attemptId, outcome }),
        };
      },
    };
  }

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
        const port = attemptPort();
        if (port === null || clientIp === undefined) {
          const admission = await risk.admit(input);
          return admission.code === 0
            ? null
            : { code: 42901, retryAfterSec: admission.retryAfterSec };
        }
        // B1-11g round 7: ① the IP items (read only, shared with the landing page), ② the device;
        // the attempt is committed once the phone quota is held (the gate).
        const ip = await port.checkAttempts({ appId, clientIp });
        if (ip.code !== 0) return { code: 42901, retryAfterSec: ip.retryAfterSec };
        const device = await port.admitDevice({ appId, deviceHash, phone: request.phone });
        if (device.code !== 0) return { code: 42901, retryAfterSec: device.retryAfterSec };
        return attemptGate(port, appId, clientIp, request.phone);
      },
      // B1-11g (BR-ID-32): the landing page send is judged by the two per-IP items only; it
      // always comes from an HTTP request, so a missing client IP is refused, never skipped.
      async landingQuota(request) {
        const appId = request.app_id;
        const clientIp = request.client_ip;
        if (clientIp === undefined) {
          logger.warn({ app_id: appId, purpose: request.purpose }, 'sms_landing_ip_missing');
          return { ...refused };
        }
        const port = attemptPort();
        if (port === null) {
          logger.error({ app_id: appId, purpose: request.purpose }, 'sms_landing_risk_missing');
          return { ...refused };
        }
        const ip = await port.checkAttempts({ appId, clientIp });
        if (ip.code !== 0) return { code: 42901, retryAfterSec: ip.retryAfterSec };
        return attemptGate(port, appId, clientIp, request.phone);
      },
      // The IP's send count is the PG attempts; recordAccepted counts the daily budget (and keeps
      // B1-03g's own Redis record, which the send path no longer reads).
      async afterAccepted(request) {
        await risk.recordAccepted({
          appId: request.app_id,
          ...(request.client_ip === undefined ? {} : { clientIp: request.client_ip }),
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
