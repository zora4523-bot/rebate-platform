// F1-09f 裁定 7 / F5: the save and publish checks of a page's sections. Shape errors of
// contracts/home-schema.json (as dotted paths), duplicate ids and unregistered types, then the
// F1-09c checks; merged with each path once. The link-pattern and channel tables are read per
// call (platform's generated snapshots); route names are the bridge route table's keys.
import { bridge } from '@couli/contracts-ts';
import { getLinkPatterns, getMaterialChannels } from '../../platform/index.ts';
import {
  mergeFields,
  sectionEnvelopeFields,
  shapeIssueFields,
  type ShapeIssue,
} from '../domain/pages/admin-sections.ts';
import { validatePageSections } from '../domain/pages/validate/index.ts';
import type { PageSectionsCheck } from './page-config-admin.ts';

export interface SectionsShape {
  issues(sections: unknown): readonly ShapeIssue[];
  readonly registeredTypes: ReadonlySet<string>;
}

export function createPageSectionsCheck(shape: SectionsShape): PageSectionsCheck {
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
    );
}
