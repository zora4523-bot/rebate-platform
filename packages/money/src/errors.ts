// Error classes of @couli/money, in their own module so that sibling modules (display.ts) can
// import them without a cycle through index.ts. Re-exported unchanged from index.ts.

/** Thrown for an amount that is not an integer number of fen, or is negative where forbidden. */
export class InvalidAmount extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAmount';
  }
}

/** Thrown for a ratio that is not a bigint in 0..10000 (basis points), or a bad sum of ratios. */
export class InvalidRatio extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRatio';
  }
}
