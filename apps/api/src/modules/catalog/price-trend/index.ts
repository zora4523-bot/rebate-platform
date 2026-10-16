// B1-29a: price trend read (BR-WATCH-05, BR-PROD-03, BR-TEXT-11); re-exported by
// catalog/index.ts. Rule tests: test/spec/catalog/price-trend/**.
export { computePriceTrend } from './compute.ts';
export { getPriceTrend } from './read.ts';
export { createKyselyPriceTrendStore } from './store.ts';
export type {
  PriceTrend,
  PriceTrendOptions,
  PriceTrendPoint,
  PriceTrendQuery,
  PriceTrendRow,
  PriceTrendRowsQuery,
  PriceTrendSourceKey,
  PriceTrendStatus,
  PriceTrendStore,
} from './types.ts';
