// B2-04zc: GET /v1/wallet/ledger (contract listWalletLedger: x-auth login, unsigned, not
// idempotent; cursor + limit). The subject is the request's token principal only (app_id, uid →
// userId), never X-App-Id, the query or the path (BR-AI-03); the query only pages. The answer's data
// is exactly what the query (application/wallet-ledger.ts) returned. No principal → 401 / 10001
// without calling the query; a cursor that is not ours (or a limit outside 1–50) → 400 / 20001 with
// the field. Plain decorator calls like the wallet summary controller.
import type { Schema } from '@couli/contracts-ts';
import { Controller, Get, HttpException, Inject, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import {
  contractRouteSchema,
  fieldsErrorEnvelope,
  tokenPrincipal,
  type TokenPrincipal,
} from '../../../platform/index.ts';
import { WalletLedgerQueryError, type WalletLedgerQuery } from '../../application/wallet-ledger.ts';

/** Nest token of the wallet ledger query bound to the entry's database handle. */
export const WALLET_LEDGER_QUERY = Symbol('WALLET_LEDGER_QUERY');

export interface WalletLedgerHttpRequest {
  readonly id: string;
  readonly principal?: TokenPrincipal;
  /** Already checked and coerced by the contract route schema. */
  readonly query?: { readonly cursor?: string; readonly limit?: number | string };
}

export class WalletLedgerController {
  readonly #query: WalletLedgerQuery;

  constructor(query: WalletLedgerQuery) {
    this.#query = query;
  }

  async list(request: WalletLedgerHttpRequest): Promise<Schema<'LedgerListResponse'>> {
    const principal = tokenPrincipal(request);
    if (principal === undefined) {
      throw new HttpException({ code: 10001, msg: '未登录', trace_id: request.id }, 401);
    }
    const query = request.query ?? {};
    try {
      const data = await this.#query({
        appId: principal.app_id,
        userId: principal.uid,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
      });
      return { code: 0, msg: '', trace_id: request.id, data };
    } catch (error) {
      if (error instanceof WalletLedgerQueryError) {
        const refused = fieldsErrorEnvelope(error.fields, request.id);
        throw new HttpException(refused.body, refused.statusCode);
      }
      throw error;
    }
  }
}

Controller('v1')(WalletLedgerController);
Inject(WALLET_LEDGER_QUERY)(WalletLedgerController, undefined, 0);
{
  const prototype = WalletLedgerController.prototype;
  const listMethod = Object.getOwnPropertyDescriptor(prototype, 'list')!;
  Get('wallet/ledger')(prototype, 'list', listMethod);
  RouteSchema(contractRouteSchema('listWalletLedger'))(prototype, 'list', listMethod);
  Req()(prototype, 'list', 0);
}
