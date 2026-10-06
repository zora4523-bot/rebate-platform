import type { AppEnv } from './app-env.ts';

// B1-02h configuration contract, consumed only through loadConfig(env):
// JWT_PRIVATE_KEY_PEM: P-256 PKCS#8 PEM text (no path, no remote key lookup).
// JWT_KEY_ID: nonempty kid, required together with JWT_PRIVATE_KEY_PEM.
// JWT_VERIFY_KEYS_JSON: optional JSON object mapping previous kids to P-256 SPKI public PEMs.
// JWT_VERIFY_KEYS_JSON must not contain JWT_KEY_ID; a duplicate is a configuration problem.
// Empty strings count as unset. Local/test with all three unset -> jwt=null; the process creates
// one ephemeral key pair at startup. Staging/prod require explicit signing configuration.
// readJwtKeyConfig reports missing cloud configuration, but loadConfig only aggregates format
// problems when JWT variables are set; missing cloud keys are rejected by createTokenKeyProvider
// at startup, preserving existing loadConfig validation. No error contains configuration values.
// AppConfig.jwt carries the result; private PEM must never enter logs or .env.example.
export interface JwtKeyConfig {
  readonly kid: string;
  readonly privateKeyPem: string;
  readonly verificationKeys: Readonly<Record<string, string>>;
}

export function readJwtKeyConfig(
  appEnv: AppEnv,
  env: Readonly<Record<string, string | undefined>>,
): { readonly jwt: JwtKeyConfig | null; readonly problems: readonly string[] } {
  void appEnv;
  void env;
  throw new Error('NotImplemented: readJwtKeyConfig');
}
