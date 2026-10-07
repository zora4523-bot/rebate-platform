import { Controller, HttpCode, HttpException, Inject, Post, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { createCatalogCardEntry, createGuestViewerContext } from '../../../catalog/index.ts';
import {
  CLOCK,
  ROOT_LOGGER,
  contractRouteSchema,
  type Clock,
  type RootLogger,
} from '../../../platform/index.ts';
import type { createParsing, ParsingResult } from '../../application/parsing.ts';
import {
  PARSING_ROUTE_PORTS,
  ParsingConfigReader,
  ParsingLinkRegistrars,
  type ParsingRoutePorts,
} from '../../ports.ts';

/**
 * The parsing service factory the route builds its per-request service with. ParsingModule.forRoot
 * takes it from the composition root, which imports it from the module's public surface
 * (parsing/index.ts) like any other caller; importing index.ts here would close a dependency
 * cycle (index.ts → parsing.module.ts → this controller).
 */
export type ParsingFactory = typeof createParsing;

/** Nest injection token of the ParsingFactory. */
export const PARSING_FACTORY = Symbol('PARSING_FACTORY');

type ParseInputResponse = Schema<'ParseInputResponse'>;
type ParseResult = Schema<'ParseResult'>;

/** What this controller reads of the Fastify request, already checked by the route schema. */
interface ParseInputRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly headers: { readonly 'x-app-id': string };
  readonly body: Schema<'ParseInputRequest'>;
}

/**
 * error-codes.yaml 50303 (暂时无法确认价格): the wire form of an active query's price_unavailable
 * (D33) until the F-37 contract sync gives it a card shape. No amount and no link_id go out.
 * TODO(规划/11 §9.2): price_unavailable 卡的线上形状 — blocked on followups F-37 契约同步
 */
const PRICE_UNAVAILABLE = 50303;

/** Whole-request answers when no result carries a hit (error-codes.yaml: both HTTP 422). */
const REQUEST_ERRORS: Readonly<Record<number, string>> = {
  30131: '不支持该链接或平台',
  30132: '未识别到具体商品',
};
const UNRECOGNIZED = 30132;

function wireResult(result: ParsingResult): ParseResult | null {
  if (result.hit === null) return null;
  switch (result.kind) {
    case 'card':
      return { hit: result.hit, card: result.card };
    case 'price_unavailable':
      return { hit: result.hit, error_code: PRICE_UNAVAILABLE };
    default:
      return { hit: result.hit, error_code: result.error_code };
  }
}

/**
 * Nest metadata is applied below without decorator syntax: rule tests import ParsingModule
 * through the app module, and their TypeScript project accepts erasable syntax only (same as
 * catalog's SearchController, B1-05j). Request scoped through the link registrations (linking
 * builds them per request).
 */
export class ParseInputController {
  readonly #config: ParsingConfigReader;
  readonly #ports: ParsingRoutePorts;
  readonly #registrars: ParsingLinkRegistrars;
  readonly #clock: Clock;
  readonly #logger: RootLogger;
  readonly #createParsing: ParsingFactory;

  constructor(
    config: ParsingConfigReader,
    ports: ParsingRoutePorts,
    registrars: ParsingLinkRegistrars,
    clock: Clock,
    logger: RootLogger,
    createParsing: ParsingFactory,
  ) {
    this.#config = config;
    this.#ports = ports;
    this.#registrars = registrars;
    this.#clock = clock;
    this.#logger = logger.child({ module: 'parsing' });
    this.#createParsing = createParsing;
  }

  /**
   * Contract operation `parseInput` (x-auth optional): one result per hit in input order, at most
   * three (04 §8.5). Cards only register a link with its quote snapshot through catalog's card
   * entry; nothing is converted here (拍板第二批 TRADE-03). The viewer is a guest of the request's
   * app until identity is wired (B1-02m): no client header promotes it. Identity and scene never
   * come from the body (the route schema rejects any other field). Nothing that names a concrete
   * product answers 30132 without candidate cards (拍板第二批 TRADE-07).
   * x-signed and the minimum-version gate are global request checks of the risk tasks.
   */
  async parse(request: ParseInputRequest): Promise<ParseInputResponse> {
    const appId = request.headers['x-app-id'];
    // TODO(规划/11 §4.5): 已登录查看者 — blocked on B1-02m（identity 接入 ViewerContext）
    const viewerContext = createGuestViewerContext({ appId, deviceId: null });
    const cards = createCatalogCardEntry({
      clock: this.#clock,
      viewerContext,
      quoter: this.#ports.quoter,
      // Links are registered in the request's entry scene, with entry_source parse.
      registrar: this.#registrars.forScene(request.body.scene),
      sourceLinks: this.#ports.sourceLinks,
      itemRefs: this.#ports.itemRefs,
      logger: this.#logger,
    });
    const parsing = this.#createParsing({
      config: this.#config,
      catalog: this.#ports.catalog,
      cards,
      clock: this.#clock,
      getGovernedAdapter: this.#ports.getGovernedAdapter,
      logger: this.#logger,
    });
    const results = await parsing.parseInput(request.body.text, {
      appId,
      requestId: request.id,
      purpose: 'online',
    });
    const wire = results.flatMap((result) => {
      const item = wireResult(result);
      return item === null ? [] : [item];
    });
    if (wire.length === 0) {
      const first = results[0];
      const code =
        first?.kind === 'error' && Object.hasOwn(REQUEST_ERRORS, first.error_code)
          ? first.error_code
          : UNRECOGNIZED;
      throw new HttpException({ code, msg: REQUEST_ERRORS[code], trace_id: request.id }, 422);
    }
    return { code: 0, msg: '', data: { results: wire }, trace_id: request.id };
  }
}

Controller('v1')(ParseInputController);
Inject(ParsingConfigReader)(ParseInputController, undefined, 0);
Inject(PARSING_ROUTE_PORTS)(ParseInputController, undefined, 1);
Inject(ParsingLinkRegistrars)(ParseInputController, undefined, 2);
Inject(CLOCK)(ParseInputController, undefined, 3);
Inject(ROOT_LOGGER)(ParseInputController, undefined, 4);
Inject(PARSING_FACTORY)(ParseInputController, undefined, 5);
const parseMethod = Object.getOwnPropertyDescriptor(ParseInputController.prototype, 'parse')!;
Post('inputs/parse')(ParseInputController.prototype, 'parse', parseMethod);
HttpCode(200)(ParseInputController.prototype, 'parse', parseMethod);
RouteSchema(contractRouteSchema('parseInput'))(
  ParseInputController.prototype,
  'parse',
  parseMethod,
);
Req()(ParseInputController.prototype, 'parse', 0);
