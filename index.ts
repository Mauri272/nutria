export { OpenFoodFactsClient } from './client';
export type { FetchLike, FetchResponseLike, LookupOptions, OffClientConfig, SearchOptions } from './client';
export { OffError } from './errors';
export type { OffErrorCode } from './errors';
export { gtinCheckDigit, normalizeBarcode } from './barcode';
export type { BarcodeFormat, NormalizedBarcode } from './barcode';
export { mapProduct, parseProductResponse, parseSearchResponse, toFoodRecord } from './mapper';
export type { OffDataWarning, OffDataWarningCode, OffLookupResult, OffProduct } from './mapper';
