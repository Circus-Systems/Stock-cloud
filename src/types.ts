/**
 * Shared types for the filings archiver.
 *
 * A "source" knows how to (a) enumerate the filings of a holding, one page at a
 * time, and (b) download a single filing into one or more R2 objects.
 * Sources must be pure with respect to I/O: every network call goes through the
 * `Fetcher` they are handed so that the Durable Object can enforce per-source
 * rate limits and so that tests can stub the network.
 */

export type SourceId = 'sec' | 'asx' | 'rns' | 'adyen';

export interface Holding {
  /** Ticker as shown by the broker, e.g. "MSFT", "BHP", "GSBE47". Used in R2 keys. */
  ticker: string;
  /** MIC of the listing: XNAS, XNYS, XASX, XLON, XAMS. Informational. */
  exchange: string;
  name?: string;
  /** Which sources to archive this holding from. */
  sources: SourceId[];
  /** SEC Central Index Key (10 digits, zero padded or not). Required for source "sec". */
  cik?: string;
  /** ASX code to query the historical announcements archive with, when it differs from `ticker`
   *  (hybrids / notes / bonds are published under the parent issuer code). */
  asxArchiveCode?: string;
  /** BrighterIR client slug, e.g. "rightmove_plc". Required for source "rns". */
  brighterir?: string;
}

export interface HoldingsConfig {
  holdings: Holding[];
}

/** Minimal fetch abstraction handed to sources. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface SourceContext {
  fetch: Fetcher;
  /** Current time, injectable for tests. */
  now: () => Date;
  /** User-Agent sent to the SEC (their fair-access policy requires a descriptive one). */
  secUserAgent?: string;
  /** Also archive the SEC complete submission text file for each filing. */
  secFullSubmission?: boolean;
}

/** A reference to one filing/announcement discovered by `list`. */
export interface FilingRef {
  source: SourceId;
  ticker: string;
  /** Unique within (source, ticker). Stable across runs. e.g. accession number, idsId, story id. */
  id: string;
  /** YYYY-MM-DD in the market's local date (as published by the source). */
  date: string;
  /** Optional HH:MM if the source provides it. */
  time?: string;
  title: string;
  /** Form / announcement type when known (10-K, 8-K, "Periodic Reports", "Transaction in Own Shares"...). */
  form?: string;
  /** URL that `download` should start from. */
  url: string;
  /** Source-specific extras persisted into the sidecar metadata. */
  extra?: Record<string, unknown>;
}

export type ListMode = 'full' | 'recent';

export interface ListPage {
  refs: FilingRef[];
  /** Opaque cursor for the next page; undefined when enumeration is complete. */
  nextCursor?: string;
}

/** One object to write to R2. */
export interface StoredObject {
  /** Full R2 key, e.g. "sec/AAPL/2024/2024-11-01_0000320193-24-000123_10-K_aapl-20240928.htm" */
  key: string;
  /** A ReadableStream is written to R2 with a streamed multipart upload (no buffering in memory). */
  body: ArrayBuffer | string | ReadableStream<Uint8Array>;
  contentType: string;
  /** Extra metadata merged into the sidecar JSON next to the object. */
  meta?: Record<string, unknown>;
}

export interface Source {
  id: SourceId;
  /** Minimum delay between two upstream requests, in milliseconds. */
  minDelayMs: number;
  /**
   * Enumerate filings. `cursor` is undefined for the first call. Return
   * `nextCursor` to be called again. In "recent" mode the source should only
   * look at what may have changed since the last daily run (and is allowed to
   * return refs that have already been archived; the caller de-duplicates).
   */
  list(holding: Holding, mode: ListMode, cursor: string | undefined, ctx: SourceContext): Promise<ListPage>;
  /** Download one filing into one or more R2 objects (a filing may have several parts). */
  download(ref: FilingRef, ctx: SourceContext): Promise<StoredObject[]>;
}

/** Durable Object job record. */
export type Job =
  | { kind: 'list'; ticker: string; mode: ListMode; cursor?: string; holding?: Holding }
  | { kind: 'download'; ref: FilingRef }
  | { kind: 'export-index'; ticker: string };

export interface Env {
  FILINGS: R2Bucket;
  CRAWLER: DurableObjectNamespace;
  ADMIN_TOKEN?: string;
  SEC_USER_AGENT?: string;
  /** "true" to also archive the SEC complete submission text file for every filing. */
  SEC_FULL_SUBMISSION?: string;
  HOLDINGS_JSON?: string;
}
