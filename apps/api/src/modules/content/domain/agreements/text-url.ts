import type { AgreementType } from './index.ts';

export function agreementTextUrl(
  h5BaseUrl: string,
  type: AgreementType,
  version: number,
): string | null {
  void h5BaseUrl;
  void type;
  void version;
  throw new Error('NotImplemented: agreementTextUrl');
}
