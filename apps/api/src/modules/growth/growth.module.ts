// growth's Nest module (task B1-11e): POST /v1/me/inviter (bindInviter) on the api entry; B1-11j adds
// GET /v1/invites/me (getMyInvite) over the invite page read, assembled the same way. The
// binding core (B1-11d, createInviteBinder) is assembled by app.module over identity's, risk's and
// content's exported readers and handed in as a factory, so growth imports none of those modules
// (growth AGENTS.md rules 4 and 6). A factory answering null (no database, Redis, field cipher or
// event bus) leaves the route failing closed with 50001.
//
// Also compiled by the `test` project (through ./index.ts): a class decorator only (no parameter
// decorators or parameter properties).
import { type DynamicModule, type FactoryProvider, Module } from '@nestjs/common';
import type { InviteBinder } from './application/invite-binder.ts';
import type { MyInviteReader } from './application/my-invite.ts';
import { INVITE_BACKFILL_BINDER, InviterController } from './http/public/inviter.controller.ts';
import { MY_INVITE_READER, MyInviteController } from './http/public/my-invite.controller.ts';

export interface GrowthModuleOptions {
  /** growth's binding core for the backfill route, as app.module assembles it. */
  readonly inviteBinder: Omit<FactoryProvider<InviteBinder | null>, 'provide'>;
  /** growth's invite page read for GET /v1/invites/me (B1-11j), as app.module assembles it. */
  readonly myInvite: Omit<FactoryProvider<MyInviteReader | null>, 'provide'>;
}

@Module({})
export class GrowthModule {
  static forRoot(options: GrowthModuleOptions): DynamicModule {
    return {
      module: GrowthModule,
      controllers: [InviterController, MyInviteController],
      providers: [
        { ...options.inviteBinder, provide: INVITE_BACKFILL_BINDER },
        { ...options.myInvite, provide: MY_INVITE_READER },
      ],
    };
  }
}
