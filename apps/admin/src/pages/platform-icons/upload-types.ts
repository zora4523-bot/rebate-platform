// Public interfaces of the upload / cleaned preview and source registration dialogs.
import type { PlatformIconKey, Schema } from '@couli/contracts-ts';

/** The upload dialog of one mark (one key per dialog; title 「上传替换图 · {平台}」). */
export interface UploadDialogProps {
  /** The mark as the list showed it when the dialog opened. */
  readonly icon: Schema<'AdminPlatformIcon'>;
  /** Closes the dialog; an upload still under way is aborted and its answer dropped. */
  readonly onClose: () => void;
  /** The upload was saved as `version`: show that key's history drawer with the success bar. */
  readonly onSaved: (version: Schema<'AdminPlatformIconVersion'>) => void;
  /** The server answered 20001 fields=[key]: close and show 「没有这个平台标识」 on the list. */
  readonly onUnknownKey: (key: PlatformIconKey) => void;
}

/** Registers or corrects the source of a never-published version (PATCH with its revision). */
export interface SourceDialogProps {
  readonly iconKey: PlatformIconKey;
  readonly version: Schema<'AdminPlatformIconVersion'>;
  readonly onClose: () => void;
  /** The version as the server returned it after the registration. */
  readonly onSaved: (version: Schema<'AdminPlatformIconVersion'>) => void;
  /** 【刷新版本历史】 after 20001 [version] or 20902: close and read the versions again. */
  readonly onRefresh: () => void;
  readonly onUnknownKey?: (key: PlatformIconKey) => void;
}
