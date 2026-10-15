// 联盟端点覆盖目录（B1-04y）：staging 节点挂载 /etc/couli-pdd → /run/couli-pdd 后，UNION_ENDPOINTS
// 工厂改从 UNION_ENDPOINT_OVERRIDE_DIR 读三平台端点文件，而不是镜像内的 config/union-endpoints/。
// 纯函数：只看传入对象，不碰文件系统，问题文本只写变量名与原因，不回显取值。
//
// - 未设或空字符串：null，任何环境都不产生问题项。
// - 只有 APP_ENV=staging 认它；local / test / prod 设了即问题项。
// - staging 只检查是否绝对路径，不检查目录或文件是否存在：staging.env 由 api、stream、worker、
//   admin 共用，stream 与 admin 没有该挂载；目录缺失由 union 启动工厂报 invalid_endpoint。
import { posix } from 'node:path';
import type { AppEnv } from './app-env.ts';

export const UNION_ENDPOINT_OVERRIDE_DIR_ENV = 'UNION_ENDPOINT_OVERRIDE_DIR';

export function readUnionEndpointOverrideConfig(
  appEnv: AppEnv,
  env: Readonly<Record<string, string | undefined>>,
): { readonly unionEndpointOverrideDir: string | null; readonly problems: readonly string[] } {
  const value = env[UNION_ENDPOINT_OVERRIDE_DIR_ENV];
  if (value === undefined || value === '') return { unionEndpointOverrideDir: null, problems: [] };
  if (appEnv !== 'staging') {
    return {
      unionEndpointOverrideDir: null,
      problems: [
        `${UNION_ENDPOINT_OVERRIDE_DIR_ENV}: must only be set when APP_ENV=staging (other environments read the packaged union endpoints)`,
      ],
    };
  }
  if (!posix.isAbsolute(value)) {
    return {
      unionEndpointOverrideDir: null,
      problems: [`${UNION_ENDPOINT_OVERRIDE_DIR_ENV}: must be an absolute path`],
    };
  }
  return { unionEndpointOverrideDir: value, problems: [] };
}
