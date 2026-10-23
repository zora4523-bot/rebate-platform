// Floor to a step (BR-WDR-03 细则 floor_to_step; BR-WDR-04 amount_step_fen): the largest multiple of
// `step_fen` (counted from 0) not above `value_fen`; a negative value floors to 0. Integer fen only,
// bounded like addFen / subFen; the step must be a positive bigint.
import { InvalidAmount } from './errors.ts';

const MIN_STORAGE_FEN = -9223372036854775808n;
const MAX_STORAGE_FEN = 9223372036854775807n;

function assertFen(value: unknown, name: string): asserts value is bigint {
  if (typeof value !== 'bigint') throw new InvalidAmount(`${name} must be bigint fen`);
  if (value < MIN_STORAGE_FEN || value > MAX_STORAGE_FEN) {
    throw new InvalidAmount(`${name} exceeds the PG bigint range`);
  }
}

export function floorToStepFen(value_fen: bigint, step_fen: bigint): bigint {
  assertFen(value_fen, 'value_fen');
  assertFen(step_fen, 'step_fen');
  if (step_fen <= 0n) throw new InvalidAmount('step_fen must be positive');
  if (value_fen <= 0n) return 0n;
  return value_fen - (value_fen % step_fen);
}
