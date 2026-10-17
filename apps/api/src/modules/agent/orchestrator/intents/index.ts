// B3-05f: Orchestrator intents and templates (IntentPort of B3-05b).
export { createIntentPort } from './port.ts';
export { parseIntentOutput } from './parse.ts';
export { intentTextPatterns } from './classify.ts';
export type { IntentTextPatterns } from './classify.ts';
export type {
  ClarificationScope,
  ClarifySlot,
  GuideRouteMetadata,
  IntentDeps,
  IntentOutput,
  IntentRequest,
  IntentTrace,
  ParsedIntent,
  TemplateCall,
} from './types.ts';
