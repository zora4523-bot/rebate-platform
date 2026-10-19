// The device signature of a clipboard_auto_import consent (B1-02zc; 04 §6.1 recordConsent: the
// operation stays x-signed false because the other consent types are unsigned, so stage ① skips
// it; a clipboard_auto_import request must still be signed, with the signing guard's rules, codes
// and nonce store: a device missing, not server-issued or revoked → 10402; a missing or invalid
// X-Timestamp / X-Nonce / X-Sign, a skew over the window, a wrong HMAC or a replayed nonce → 10401).
//
// The verification is risk's createRequestSignatureVerifier (the stage ① checks without the
// x-signed route gate; the same Redis nonce keys), over the raw request bytes (orchestrator ruling:
// never a re-serialisation). Those bytes exist only before Fastify parses the body, so this runs as
// a request check at the platform's pre-parsing registration point, the way stage ① runs for the
// x-signed routes: app.module buffers the raw body of recordConsent only and places this check
// right after stage ① and before the token stages ② ③ (BR-ID-01 order). It acts on POST
// /v1/consents whose raw body is a JSON object with type=clipboard_auto_import, and publishes the
// verified device as `verifiedDevice` (copied onto the request like stage ①'s); every other
// request passes untouched. The handler then requires verifiedDevice for that type (fail closed:
// a body this check could not read as JSON but Fastify could is answered 10401 there).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import type { RequestCheck } from '../../platform/index.ts';
import type { RequestSignatureVerifier } from '../../risk/index.ts';
import { CLIPBOARD_CONSENT_TYPE } from './consents.ts';

/** Fastify's route template of recordConsent (contracts/openapi.yaml). */
export const RECORD_CONSENT_ROUTE = '/v1/consents';

/** True for recordConsent: the one unsigned route whose raw body app.module buffers. */
export function isRecordConsentRoute(method: string, routeTemplate: string | undefined): boolean {
  return method.toUpperCase() === 'POST' && routeTemplate === RECORD_CONSENT_ROUTE;
}

/** True when the raw body is a JSON object declaring type=clipboard_auto_import. */
function declaresClipboard(rawBody: Buffer): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    // Not JSON: Fastify's parser answers it; the handler never sees a clipboard body unverified.
    return false;
  }
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    (parsed as { readonly type?: unknown }).type === CLIPBOARD_CONSENT_TYPE
  );
}

/** The pre-parsing check described above; `verify` is risk's single-request verifier. */
export function createConsentSignatureCheck(verify: RequestSignatureVerifier): RequestCheck {
  if (typeof verify !== 'function') {
    throw new TypeError('createConsentSignatureCheck needs the signature verifier');
  }
  return async (request) => {
    if (!isRecordConsentRoute(request.method, request.routeTemplate)) return;
    if (!declaresClipboard(request.rawBody)) return;
    request.verifiedDevice = await verify(request);
  };
}
