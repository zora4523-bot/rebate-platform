export const APP_ENVS = ['local', 'test', 'staging', 'prod'] as const;
export type AppEnv = (typeof APP_ENVS)[number];
