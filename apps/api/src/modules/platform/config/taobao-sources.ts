// 淘宝实时适配器的两个大淘客开关（B1-04zn，D10-530）：服务端配置，不是密钥，不登记进
// ./credential-env.ts，任何 APP_ENV 都可设（是否真正走大淘客还要 taobao live 且大淘客凭据就位，
// 由 union 模块装配决定）。纯函数：只看传入对象，问题文本只写变量名，不回显取值。
//
// - TAOBAO_CONVERT_SOURCE ∈ {baichuan, dataoke}：未设或空串 → baichuan（转链保持现状）。
// - TAOBAO_SEARCH_SOURCE ∈ {official, dataoke}：未设或空串 → official（搜索保持现状，
//   adapter_unimplemented 直到官方接口批下）。
// - 其他取值（大小写不同也算）→ 问题项，只写变量名。

export const TAOBAO_CONVERT_SOURCE_ENV = 'TAOBAO_CONVERT_SOURCE';
export const TAOBAO_SEARCH_SOURCE_ENV = 'TAOBAO_SEARCH_SOURCE';

export const TAOBAO_CONVERT_SOURCES = ['baichuan', 'dataoke'] as const;
export const TAOBAO_SEARCH_SOURCES = ['official', 'dataoke'] as const;

export type TaobaoConvertSourceSetting = (typeof TAOBAO_CONVERT_SOURCES)[number];
export type TaobaoSearchSourceSetting = (typeof TAOBAO_SEARCH_SOURCES)[number];

function readChoice<T extends string>(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  choices: readonly T[],
  fallback: T,
  problems: string[],
): T {
  const value = env[name];
  if (value === undefined || value === '') return fallback;
  const chosen = choices.find((choice) => choice === value);
  if (chosen === undefined) {
    problems.push(name);
    return fallback;
  }
  return chosen;
}

export function readTaobaoSourceConfig(env: Readonly<Record<string, string | undefined>>): {
  readonly taobaoConvertSource: TaobaoConvertSourceSetting;
  readonly taobaoSearchSource: TaobaoSearchSourceSetting;
  readonly problems: readonly string[];
} {
  const problems: string[] = [];
  const taobaoConvertSource = readChoice(
    env,
    TAOBAO_CONVERT_SOURCE_ENV,
    TAOBAO_CONVERT_SOURCES,
    'baichuan',
    problems,
  );
  const taobaoSearchSource = readChoice(
    env,
    TAOBAO_SEARCH_SOURCE_ENV,
    TAOBAO_SEARCH_SOURCES,
    'official',
    problems,
  );
  return { taobaoConvertSource, taobaoSearchSource, problems };
}
