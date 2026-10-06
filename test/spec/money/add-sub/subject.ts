// Public exports are added in the implementation phase. Resolve the source skeleton by URL
// because tsc cannot rewrite a relative import across these project output directories.
// Keep this test-side API declaration aligned with the skeleton in money/src/add-sub.ts.
interface AddSubApi {
  addFen(left: bigint, right: bigint): bigint;
  subFen(left: bigint, right: bigint, options?: { nonNegative?: boolean }): bigint;
}

export const { addFen, subFen }: AddSubApi = await import(
  new URL('../../../../packages/money/src/add-sub.ts', import.meta.url).href
);
