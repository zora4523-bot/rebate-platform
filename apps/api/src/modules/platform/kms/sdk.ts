// B1-30a (FU-KMS-ADAPTER): the only file of the repository that imports the KMS SDK, with a dynamic
// import() (docs-mirror/aliyun-kms/pages/). Skeleton of the rule-test author; the rule tests stub this
// file with vi.mock and never touch the real SDK or the network.
import type { KmsConfig } from '../config/kms.ts';

export interface KmsSdkClient {
  getSecretValue(request: {
    secretName: string;
  }): Promise<{ secretData?: string; secretDataType?: string }>;
  encrypt(request: {
    keyId: string;
    plaintext: string;
    encryptionContext: Record<string, string>;
  }): Promise<{ ciphertextBlob?: string }>;
  decrypt(request: {
    ciphertextBlob: string;
    encryptionContext: Record<string, string>;
  }): Promise<{ plaintext?: string }>;
}

export async function createKmsSdkClient(config: KmsConfig): Promise<KmsSdkClient> {
  void config;
  throw new Error('NotImplemented: createKmsSdkClient');
}
