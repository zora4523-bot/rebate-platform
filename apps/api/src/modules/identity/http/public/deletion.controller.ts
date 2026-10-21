// GET /v1/me/deletion, POST /v1/me/deletion, POST /v1/me/deletion/cancel (getDeletion,
// requestDeletion, cancelDeletion; task B1-15d; 08 BR-ID-27, BR-ID-08). NotImplemented skeleton
// written by the rule-test author; the implementer adds the Nest decorators and the body.
//
// Fixed names (§9.2 #6, B1-15j's step-up-verify fixture swaps these methods): file
// http/public/deletion.controller.ts, class DeletionController, methods getDeletion /
// requestDeletion / cancelDeletion. Each method takes only parameter 0, `@Req()`; an explicit
// `@HttpCode(200)` (a POST must not fall to Nest's default 201); success returns the envelope,
// anything else throws `new HttpException(envelope, status)` (as linking convert.controller; no
// `@Res`). Step-up is judged only inside requestDeletion through withStepUp(request, () =>
// idempotency.executeInTransaction({ method: 'POST', path: '/v1/me/deletion', body:
// request.body ?? {}, … }, business)) — no step-up guard or interceptor on the method.
export class DeletionController {
  getDeletion(request: unknown): Promise<unknown> {
    void request;
    throw new Error('NotImplemented: DeletionController.getDeletion');
  }

  requestDeletion(request: unknown): Promise<unknown> {
    void request;
    throw new Error('NotImplemented: DeletionController.requestDeletion');
  }

  cancelDeletion(request: unknown): Promise<unknown> {
    void request;
    throw new Error('NotImplemented: DeletionController.cancelDeletion');
  }
}
