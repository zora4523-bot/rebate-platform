export type EvalSet = 'smoke' | 'find' | 'badcase' | 'baseline-pairs' | 'judges';
export type Category =
  | 'T1'
  | 'T2'
  | 'T3'
  | 'T4'
  | 'T5'
  | 'T6'
  | 'injection'
  | 'unauthorized'
  | 'identity_arg'
  | 'banned'
  | 'promise_bait'
  | 'unverified_cap'
  | 'boundary_normal'
  | 'chitchat';
export type Split = 'tune' | 'validate' | 'holdout';
export type Provenance =
  'synthetic' | 'vendor_synthetic' | 'aggregated_stats' | 'rewritten' | 'real_link_sample';
export type Subject = 'guest' | 'logged_in' | 'bound_phone';
export type Intent =
  | 'find_by_link'
  | 'search'
  | 'refine'
  | 'order_query'
  | 'rule_qa'
  | 'handoff'
  | 'clarify'
  | 'out_of_scope'
  | 'page_guide'
  | 'earnings_query';
export type Forbid =
  'amount_in_text' | 'url_in_text' | 'identity_arg' | 'banned_word_in_text' | 'auto_redirect';

export interface EvalCase {
  id: string;
  set: EvalSet;
  category: Category;
  split: Split;
  group: string;
  provenance: Provenance;
  source_ref?: string;
  subject: Subject;
  switches?: Record<string, boolean>;
  turns: { text: string; untrusted?: boolean }[];
  expect: {
    intent: Intent;
    tools?: { name: string; args?: Record<string, unknown> }[];
    cards?: string[];
    forbid?: Forbid[];
  };
  retired?: { at: string; reason: string };
}

export interface Manifest {
  set: EvalSet;
  version: string;
  count: number;
  by_category: Partial<Record<Category, number>>;
  content_sha256: string;
  split_sha256: string;
}

export interface Problem {
  code: string;
  id?: string;
  file?: string;
  line?: number;
  message: string;
}

export function validateCase(value: unknown): Problem[] {
  void value;
  throw new Error('NotImplemented: validateCase');
}

export function parseJsonl(text: string, file: string): { cases: EvalCase[]; problems: Problem[] } {
  void text;
  void file;
  throw new Error('NotImplemented: parseJsonl');
}

export function computeManifest(set: EvalSet, version: string, cases: EvalCase[]): Manifest {
  void set;
  void version;
  void cases;
  throw new Error('NotImplemented: computeManifest');
}

export function checkManifest(manifest: Manifest, cases: EvalCase[]): Problem[] {
  void manifest;
  void cases;
  throw new Error('NotImplemented: checkManifest');
}

export function checkSplitLeak(cases: EvalCase[]): Problem[] {
  void cases;
  throw new Error('NotImplemented: checkSplitLeak');
}

export function checkNearDuplicates(cases: EvalCase[]): Problem[] {
  void cases;
  throw new Error('NotImplemented: checkNearDuplicates');
}

export function checkAppendOnly(
  prev: EvalCase[],
  next: EvalCase[],
  changes?: { id: string; reason: string }[],
): Problem[] {
  void prev;
  void next;
  void changes;
  throw new Error('NotImplemented: checkAppendOnly');
}

export function checkSmokeComposition(cases: EvalCase[]): Problem[] {
  void cases;
  throw new Error('NotImplemented: checkSmokeComposition');
}
