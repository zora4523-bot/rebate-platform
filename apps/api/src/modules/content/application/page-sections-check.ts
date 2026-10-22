// F1-09f 裁定 7 / F5: the save and publish checks of a page's sections. Shape errors of
// contracts/home-schema.json (as dotted paths), duplicate ids and unregistered types, then the
// F1-09c checks; merged with each path once. The link-pattern and channel tables are read per
// call (platform's generated snapshots); route names are the bridge route table's keys.
// F1-09r: a popup's props.lottie must reference the media address of a JSON file named by its
// sha256 (MEDIA_PUBLIC_BASE_URL; without it no reference is valid); the file is never fetched.
import { bridge } from '@couli/contracts-ts';
import {
  getLinkPatterns,
  getMaterialChannels,
  MediaStoreUnavailableError,
  mediaUrlOf,
} from '../../platform/index.ts';
import {
  mergeFields,
  sectionEnvelopeFields,
  shapeIssueFields,
  type ShapeIssue,
} from '../domain/pages/admin-sections.ts';
import { popupLottieFields } from '../domain/pages/popup-lottie.ts';
import { validatePageSections } from '../domain/pages/validate/index.ts';
import type { PageSectionsCheck } from './page-config-admin.ts';

export interface SectionsShape {
  issues(sections: unknown): readonly ShapeIssue[];
  readonly registeredTypes: ReadonlySet<string>;
}

/** The media address of a Lottie JSON named by `sha256`; undefined when media is unconfigured. */
function lottieUrlOf(baseUrl: string | undefined, sha256: string): string | undefined {
  try {
    return mediaUrlOf(baseUrl, sha256, 'json');
  } catch (error) {
    if (error instanceof MediaStoreUnavailableError) return undefined;
    throw error;
  }
}

export function createPageSectionsCheck(
  shape: SectionsShape,
  mediaPublicBaseUrl?: string,
): PageSectionsCheck {
  const routeNames: ReadonlySet<string> = new Set(Object.keys(bridge.routes));
  return (sections, unionHostBlock) =>
    mergeFields(
      shapeIssueFields(shape.issues(sections)),
      sectionEnvelopeFields(sections, shape.registeredTypes),
      validatePageSections(sections, {
        unionHostBlock,
        linkPatterns: getLinkPatterns(),
        materialChannels: getMaterialChannels(),
        routeNames,
      }),
      popupLottieFields(sections, (sha256) => lottieUrlOf(mediaPublicBaseUrl, sha256)),
    );
}
