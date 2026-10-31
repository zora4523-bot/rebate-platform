// 大淘客开放平台请求底座（B1-04m，D10-486 ①；淘宝订单 / 维权 / 违规的数据源）。
// - 网关：baseUrl（只允许 https，否则 invalid_endpoint，不取凭据、不发请求）+ 调用方给的绝对路径
//   （以单个 / 开头，不含 ? # \ 与 . / .. 段，否则 invalid_dto）。
// - 公共参数：appKey、version（调用方给，空 → invalid_dto）、timer（注入 Clock 的毫秒时间戳）、
//   nonce（每次请求调一次注入随机源 random(1000000)，补零到 6 位；随机源给出非法值 → RangeError）、
//   signRan（见 sign.ts，业务参数不参与）。业务参数与公共参数同名或为非有限数字 → invalid_dto，不发请求。
//   业务参数值 undefined / null / '' 不发送；数字、布尔按字符串形式。
// - GET：全部参数在查询串，无请求体；POST：全部参数在 UTF-8 表单体
//   （application/x-www-form-urlencoded;charset=utf-8），URL 不带查询串。
// - 凭据每次请求经注入的提供者取一次，构造时不取；appSecret 只在内存参与签名，不进 URL、表单、
//   请求头、错误、warn 与对象自身。不读 process.env、不读文件。
// - 经注入的 UnionTransport 发送（platform 'taobao'）；调用方 AbortSignal 与归档上下文原样挂在传输请求上，
//   不上线路。传输抛错（非 UnionError）→ upstream_unavailable（不带原文、不挂 cause）。
// - 响应解包与错误分类见 response.ts；返回 data 对象，不做订单字段映射（B1-04f / B1-04z）。
import type { Clock } from '../../../platform/index.ts';
import type { ArchiveContext, UnionTransport } from '../replay.ts';
import type { DataokeWarning } from './response.ts';

export type { DataokeWarning } from './response.ts';
export type { DataokeSignInput } from './sign.ts';

/** Application-level key pair; fetched once per request, never stored on the client. */
export interface DataokeCredentials {
  readonly appKey: string;
  readonly appSecret: string;
}

/**
 * Random source for nonce: returns an integer in [0, bound). The client calls it once per request
 * with bound 1000000 (deployment wiring passes node:crypto randomInt; tests pass a fixed value).
 */
export type DataokeRandom = (bound: number) => number;

/** undefined / null / '' are not sent; numbers and booleans go out in their string form. */
export type DataokeParameter = string | number | boolean | null | undefined;
export type DataokeParameters = Readonly<Record<string, DataokeParameter>>;

export type DataokeHttpMethod = 'GET' | 'POST';

export interface DataokeClientOptions {
  readonly credentials: () => Promise<DataokeCredentials>;
  readonly transport: UnionTransport;
  readonly clock: Clock;
  readonly random: DataokeRandom;
  /** Gateway origin from deployment config (https://openapi.dataoke.com); https only. */
  readonly baseUrl: string;
  readonly warn?: (event: DataokeWarning) => void;
}

export interface DataokeRequestOptions {
  /** Interface version given by the caller (orders / refunds / punishments: v1.0.0). */
  readonly version: string;
  readonly signal?: AbortSignal;
  /** Rides on the transport request for the archiving transport only; never on the wire. */
  readonly archive?: ArchiveContext;
}

export class DataokeClient {
  constructor(options: DataokeClientOptions) {
    void options;
    throw new Error('NotImplemented: DataokeClient');
  }

  /** Signs and sends one request to baseUrl + path; returns the response `data` object. */
  async request(
    method: DataokeHttpMethod,
    path: string,
    parameters: DataokeParameters,
    options: DataokeRequestOptions,
  ): Promise<Readonly<Record<string, unknown>>> {
    void method;
    void path;
    void parameters;
    void options;
    throw new Error('NotImplemented: DataokeClient.request');
  }
}
