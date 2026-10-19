import type { Schema } from '@couli/contracts-ts';

export interface AgreementAdminRequest {
  readonly id: string;
}

export interface AgreementListQuery {
  readonly type?: Schema<'AgreementType'>;
  readonly page?: number;
  readonly page_size?: number;
}

// F1-02p test phase: registration, guards and persistence belong to the implementation phase.
export class AdminAgreementsController {
  list(
    request: AgreementAdminRequest,
    query: AgreementListQuery,
  ): Promise<Schema<'AdminAgreementVersionListResponse'>> {
    void request;
    void query;
    throw new Error('NotImplemented: AdminAgreementsController.list');
  }

  detail(
    request: AgreementAdminRequest,
    type: Schema<'AgreementType'>,
    version: number,
  ): Promise<Schema<'AdminAgreementVersionDetailResponse'>> {
    void request;
    void type;
    void version;
    throw new Error('NotImplemented: AdminAgreementsController.detail');
  }

  publish(
    request: AgreementAdminRequest,
    type: Schema<'AgreementType'>,
    body: Schema<'AdminAgreementPublishRequest'>,
  ): Promise<Schema<'AdminAgreementVersionResponse'>> {
    void request;
    void type;
    void body;
    throw new Error('NotImplemented: AdminAgreementsController.publish');
  }
}
