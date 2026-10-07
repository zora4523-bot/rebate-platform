// WireMock load-test stubs (QA-06b; 规划/05 QA-06「k6 峰值 3 倍……上游用 WireMock」; 09 README §0.2
// hard rule 5: load only ever hits local fakes, never a real union or model endpoint). QA-06a's k6
// scripts put load on the API; the API's adapters point at this local WireMock.
//
// Union stubs replay B1-04c recordings (fixtures/union-recordings/<platform>/<scenario>/
// {recording.json,provenance.json}) verbatim; without a recording there is no union success stub
// (AGENTS.md hard rule 7). The public repository only holds `source: synthetic` samples; real
// recordings stay in the private repository and are rendered on the owner's machine only.
// Bailian stubs answer in the public OpenAI-compatible streaming format (SSE, tool-call
// fragments, a usage chunk, `data: [DONE]`) with synthetic content only.
//
// The output of buildLoadImport is the body of WireMock's POST /__admin/mappings/import; the
// container is defined in compose.yaml and started only by a future drill script.

import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseUnionRecordingProvenance } from '../../../apps/api/src/modules/union/infra/replay.ts';
import { checkDirectory, readJsonFile, validateRecording } from './recordings.ts';
import { streamBody, validateToolCall } from './stream.ts';

export type LoadPlatform = 'taobao' | 'jd' | 'pdd';

/** Kind of an injected fault slot. */
export type LoadFaultKind = 'server_error' | 'rate_limited' | 'connection_reset';

/** One B1-04c recording directory, both files parsed as JSON but otherwise untouched. */
export interface UnionRecordingInput {
  platform: LoadPlatform;
  scenario: string;
  recording: unknown;
  provenance: unknown;
}

export interface LoadToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface LoadStubOptions {
  /** Fixed delay of every success response, integer milliseconds in [0, 60000]; default 0. */
  delayMs?: number;
  /** Share of requests per stub group answered with a fault, integer percent in [0, 100]; default 0. */
  faultPercent?: number;
  /** Fault used in fault slots; default `server_error`. */
  faultKind?: LoadFaultKind;
  /** Tool call the first Bailian turn streams; default `search_products`. */
  toolCall?: LoadToolCall;
}

/** WireMock 3 JSON mapping format, the subset these stubs use. */
export type LoadStringMatcher =
  { equalTo: string } | { contains: string } | { doesNotContain: string };

export interface LoadStubRequest {
  method: 'GET' | 'POST' | 'ANY';
  url?: string;
  urlPath?: string;
  urlPathPattern?: string;
  headers?: Record<string, LoadStringMatcher>;
  bodyPatterns?: LoadStringMatcher[];
}

export interface LoadStubResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  fixedDelayMilliseconds?: number;
  fault?: 'CONNECTION_RESET_BY_PEER' | 'EMPTY_RESPONSE' | 'MALFORMED_RESPONSE_CHUNK';
}

export interface LoadStubMapping {
  id: string;
  name: string;
  priority: number;
  scenarioName?: string;
  requiredScenarioState?: string;
  newScenarioState?: string;
  request: LoadStubRequest;
  response: LoadStubResponse;
}

export interface LoadImport {
  mappings: LoadStubMapping[];
}

/** Reads every <root>/<platform>/<scenario>/ that holds both files; a missing root throws. */
export function readUnionRecordings(root: string): UnionRecordingInput[] {
  checkDirectory(root);
  const result: UnionRecordingInput[] = [];
  for (const platform of ['taobao', 'jd', 'pdd'] as const) {
    if (!readdirSync(root).includes(platform)) continue;
    const directory = join(root, platform);
    checkDirectory(directory);
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error('Recording directories must not be links');
      if (!entry.isDirectory()) continue;
      const scenario = entry.name;
      const folder = join(directory, scenario);
      checkDirectory(folder);
      const names = readdirSync(folder);
      if (!names.includes('recording.json') && !names.includes('provenance.json')) continue;
      const input = {
        platform,
        scenario,
        recording: readJsonFile(join(folder, 'recording.json')),
        provenance: readJsonFile(join(folder, 'provenance.json')),
      };
      validateInput(input);
      result.push(input);
    }
  }
  return result;
}

function validateInput(input: UnionRecordingInput) {
  if (!['taobao', 'jd', 'pdd'].includes(input.platform)) throw new Error('Invalid platform');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.scenario)) {
    throw new Error('Invalid scenario');
  }
  parseUnionRecordingProvenance(input.provenance);
  return validateRecording(input.recording);
}

function integerOption(value: number | undefined, fallback: number, max: number): number {
  const chosen = value === undefined ? fallback : value;
  if (!Number.isInteger(chosen) || chosen < 0 || chosen > max) {
    throw new Error(`Expected an integer in [0, ${String(max)}]`);
  }
  return chosen;
}

/** Stable version-8 UUID in a namespace distinct from QA-05a. */
function mappingId(name: string): string {
  const hex = createHash('sha256').update(`couli-load/QA-06b/${name}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function faultResponse(kind: LoadFaultKind): LoadStubResponse {
  if (kind === 'connection_reset') return { fault: 'CONNECTION_RESET_BY_PEER' };
  if (kind === 'rate_limited') return { status: 429, headers: { 'Retry-After': '1' } };
  return { status: 503 };
}

function groupMappings(
  name: string,
  request: LoadStubRequest,
  response: LoadStubResponse,
  percent: number,
  kind: LoadFaultKind,
): LoadStubMapping[] {
  // Keep the replay baseline, including at 100% faults. Every reachable ring state has a
  // higher-priority mapping, so this baseline cannot bypass the configured fault slots.
  const mappings: LoadStubMapping[] = [
    { id: mappingId(name), name, priority: 10, request, response },
  ];
  if (percent === 0) return mappings;
  const state = (slot: number) => (slot === 0 ? 'Started' : `slot-${String(slot)}`);
  for (let slot = 0; slot < 100; slot += 1) {
    const slotName = `${name}/${String(slot)}`;
    // Spread faults across the ring, without random sampling or clocks.
    const faulty = Math.floor(((slot + 1) * percent) / 100) > Math.floor((slot * percent) / 100);
    mappings.push({
      id: mappingId(slotName),
      name: slotName,
      priority: 1,
      scenarioName: `load/${name}`,
      requiredScenarioState: state(slot),
      newScenarioState: state((slot + 1) % 100),
      request,
      response: faulty ? faultResponse(kind) : response,
    });
  }
  return mappings;
}

/**
 * Bailian streaming stubs plus one replay stub group per recording. Invalid options, provenance
 * or recording envelopes throw instead of producing a stub.
 */
export function buildLoadImport(
  recordings: readonly UnionRecordingInput[],
  options: LoadStubOptions,
): LoadImport {
  const delay = integerOption(options.delayMs, 0, 60_000);
  const percent = integerOption(options.faultPercent, 0, 100);
  const kind = options.faultKind === undefined ? 'server_error' : options.faultKind;
  if (!['server_error', 'rate_limited', 'connection_reset'].includes(kind)) {
    throw new Error('Invalid faultKind');
  }
  const tool = validateToolCall(options.toolCall);
  const mappings: LoadStubMapping[] = [];
  const keys = new Set<string>();
  for (const input of recordings) {
    const recording = validateInput(input);
    const name = `union/${input.platform}/${input.scenario}`;
    if (keys.has(name)) throw new Error('Duplicate platform/scenario');
    keys.add(name);
    mappings.push(
      ...groupMappings(
        name,
        {
          method: recording.request.method,
          url: `/union/${input.platform}${recording.request.path}`,
          headers: { 'X-Scenario': { equalTo: input.scenario } },
          // An omitted body is an empty HTTP entity; never accept an arbitrary request body.
          bodyPatterns: [{ equalTo: recording.request.body ?? '' }],
        },
        { ...recording.response, fixedDelayMilliseconds: delay },
        percent,
        kind,
      ),
    );
  }
  for (const turn of ['tool', 'text'] as const) {
    mappings.push(
      ...groupMappings(
        `bailian/${turn}`,
        {
          method: 'POST',
          urlPath: '/bailian/compatible-mode/v1/chat/completions',
          // The gateway serializes tool results with tool_call_id. The quoted JSON key is
          // independent of whitespace, unlike matching a serialized role/value pair.
          bodyPatterns: [
            turn === 'text' ? { contains: '"tool_call_id"' } : { doesNotContain: '"tool_call_id"' },
          ],
        },
        {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
          },
          body: streamBody(turn, tool),
          fixedDelayMilliseconds: delay,
        },
        percent,
        kind,
      ),
    );
  }
  return { mappings };
}
