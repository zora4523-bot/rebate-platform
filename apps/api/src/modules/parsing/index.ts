// Public surface of the parsing module (规划/02 §4.1: parsing → union, catalog; never linking).
// Other modules import only from this file. Task B1-07a: parse_input core (createParsing), the
// link pattern classification (classifyParsingUrl) and the by-URL port for B1-06i (parseUrl).
// Rule tests: test/spec/parsing/core/**. Task B1-07b: the POST /v1/inputs/parse route
// (ParseInputController, registered by ParsingModule), rule tests test/spec/parsing/http/**.
export {
  createParsing,
  DEPENDENCY_DOWN,
  INTERNAL_FAILURE,
  OFF_SHELF,
  ParsingError,
  parseUrl,
  UNRECOGNIZED,
  UNSUPPORTED,
} from './application/parsing.ts';
export type {
  ParsedUrlProduct,
  ParsingErrorCode,
  ParsingHit,
  ParsingOptions,
  ParsingResult,
  ParsingService,
} from './application/parsing.ts';
export { classifyParsingUrl } from './domain/link-patterns.ts';
export type { LinkPatternCategory, ParsingUrlMatch } from './domain/link-patterns.ts';
export { extractCandidates, MAX_CANDIDATES } from './domain/candidates.ts';
export type { Candidate } from './domain/candidates.ts';
export { ParsingConfigReader, ParsingLinkRegistrars } from './ports.ts';
export type { ParseScene } from './ports.ts';
export { ParsingModule } from './parsing.module.ts';
export type {
  ItemRefCipher,
  ParsingConfigReaderFactory,
  ParsingModuleOptions,
} from './parsing.module.ts';
