# stock-cloud — filings archiver

A Cloudflare Worker that downloads the **entire filing / announcement history** of a
share portfolio into an R2 bucket and then checks for new filings **every day**.

| Listing | Source archived | Coverage |
|---|---|---|
| US (XNAS / XNYS) and dual‑listed ADRs/CDIs | SEC EDGAR (`data.sec.gov` submissions API + `www.sec.gov/Archives`) | every filing since 1994: primary document per filing (10‑K, 10‑Q, 8‑K, Form 4, N‑CSR …). Optionally the complete submission text file. |
| ASX | ASX historical announcements archive (1998→, one page per year) + Markit "recent announcements" JSON | every PDF announcement from 2002 on; pre‑2002 text announcements stored as `.txt` |
| London (XLON) | the company's own RNS feed (BrighterIR, as embedded on the investor‑relations site) | every RNS since 2004 as HTML, plus the PDF export |
| Amsterdam (XAMS) | investors.adyen.com (financials, general meetings, events, governance hubs and sub‑pages) + the adyen.com press‑release feed | every published document (shareholder letters, annual reports, Pillar 3, AGM papers, iXBRL packs) and every press release as HTML with its attached PDFs — Adyen publishes its regulatory announcements as press releases |

| all holdings | Yahoo Finance chart endpoint (unofficial) | full daily OHLC, adjusted close, volume, dividends and splits, rewritten every day as `prices/{TICKER}.csv` (+ `.json` with currency/exchange/bar count) |

The portfolio is `holdings.json` (57 holdings: the two CommSec accounts plus the
international account). Dual‑listed names (BHP, RIO, XYZ/Block) are archived from
both ASX and SEC. ASX hybrids/notes/bonds that the archive publishes under the parent
issuer code carry an `asxArchiveCode` (GSBE47→GSB, MA2HA→MA2, CVCHB→CVC, LFSPB→LFS,
NFNG→NUF).

## Layout in the bucket `stock-filings`

```
sec/AAPL/2024/2024-11-01_0000320193-24-000123_10-K_aapl-20240928.htm
sec/AAPL/2024/2024-11-01_0000320193-24-000123_10-K_aapl-20240928.htm.meta.json
asx/BHP/2024/2024-12-18_02897739_federal-court-of-australia-class-action-proceeding.pdf
asx/BHP/1998/1998-12-30_doc144356_section-235-notice-director-s-interests.txt
rns/RMV/2023/2023-09-21_xennvzx_transaction-in-own-shares.html   (+ .pdf)
adyen/ADYEN/2026/shareholder-letter-and-interim-financial-statements-h1-2026_asset-146118.pdf
adyen/ADYEN/2026/2026-08-13_pr_adyen-publishes-h1-2026-financial-results.html   (+ attached assets)
prices/BHP.csv                     # date,open,high,low,close,adjclose,volume,dividend,split (since 1988)
prices/BHP.json                    # symbol, currency, exchange, bars, firstDate, lastDate
_index/<source>/<TICKER>.json      # one JSON index per holding, rewritten after every sync
```

Every object has a `.meta.json` sidecar with the filing metadata (form, dates, source
URL, accession number / idsId / story id, price‑sensitivity flag, …) and R2 custom
metadata (`source`, `ticker`, `id`, `date`, `form`, `title`).

## How it works

* `src/index.ts` — Worker entry. The cron trigger (`0 20 * * *` UTC = 07:00 Sydney)
  queues a **recent** sync of every holding on every source. An HTTP admin API queues
  backfills, shows status and lets you retry failures.
* `src/crawler.ts` — a SQLite‑backed Durable Object, **one instance per source**
  (`sec`, `asx`, `rns`, `adyen`). It holds a job queue (`list` → `download` →
  `export-index`), a `seen` table of archived filings and a `failed` table. Its alarm
  handler processes up to 60 jobs (≤45 s) per invocation with a small per‑source
  concurrency (SEC 6, ASX 5, RNS 3, Adyen 2) and immediately re‑arms itself, so a
  multi‑thousand‑document backfill is spread over many short invocations. All upstream
  requests of one source go through a shared slot‑based throttle (SEC ≤ ~6 req/s, ASX
  ≤ ~3 req/s, the others ≤ 2.5 req/s). Large bodies are streamed into R2 as multipart
  uploads, never buffered whole. Jobs retry with exponential back‑off (6 attempts) before
  being parked in `failed`. Note that a `wrangler deploy` resets the Durable Objects: jobs
  in flight at that moment fail once and are retried 30 s later.
* `src/sources/*.ts` — one module per data source implementing `list()` (paged
  enumeration, with a `full` and a `recent` mode) and `download()` (returns the R2
  objects for one filing). They are pure with respect to I/O (all HTTP via the context
  fetcher) and unit‑tested against real captured fixtures in `test/fixtures`.

## Admin API

Everything that mutates needs `Authorization: Bearer <ADMIN_TOKEN>` (a Worker secret).

```
GET  /                         overview
GET  /status                   per source: queue depth, archived counts, last error, last batch timing, recent jobs
GET  /holdings                 the configured portfolio
GET  /index/:source/:TICKER    archived filings for one holding
GET  /failed/:source           jobs that gave up
POST /backfill                 full‑history sync of every holding (run once)
POST /sync?ticker=BHP&source=asx&mode=full|recent   (both filters optional)
POST /retry/:source            re‑queue failed jobs
POST /forget/:source/:TICKER[?id=…]   forget archived filings so they are fetched again
POST /kick                     re‑arm the alarms (after a deploy)
POST /probe  {url, headers}    fetch a URL from the Worker's egress (diagnostics, e.g. SEC blocks)
```

## Develop / deploy

```bash
npm install
npm test                 # vitest, offline, fixture based
npm run typecheck
npx wrangler types       # regenerate worker-configuration.d.ts after editing wrangler.toml
npx wrangler deploy
npx wrangler secret put ADMIN_TOKEN
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://stock-filings.<subdomain>.workers.dev/backfill
```

Configuration (`wrangler.toml` `[vars]`): `SEC_USER_AGENT` (the SEC requires a
descriptive User‑Agent; keep it accurate), `SEC_FULL_SUBMISSION` (`"true"` to also
store every complete submission `.txt`). The holdings file can be overridden at runtime
with a `HOLDINGS_JSON` var.

## Adding or removing a holding

Edit `holdings.json`, redeploy, then `POST /sync?ticker=NEW&mode=full`. Removing a
holding stops future syncs; existing objects stay in the bucket.

## Known limitations

* ASX: the historical archive does not know some ETF / note codes (e.g. ICME); for those
  only the Markit "latest 5" feed is polled daily, so history before the first run is
  not available from ASX.
* ASX announcements for notes/bonds are archived under the parent issuer's full
  announcement stream (e.g. everything CVC publishes, not only CVCHB items).
* Adyen has no regulatory filing API; documents are discovered from the investor site, so
  dates for older hub documents are approximate (year‑level, `dateUnknown` flagged in meta).
  Press releases carry the publication date printed on the page. The feed mixes regulatory
  releases with customer‑announcement marketing; both are archived (see `form`/`title`).
* Prices come from Yahoo's undocumented chart API (symbol = ticker + `.AX`/`.L`/`.AS`,
  overridable per holding with `yahoo`). The thinly traded ASX notes/bonds have no history
  there, so only their `.json` is written. If Yahoo changes, swap the endpoint in
  `src/sources/prices.ts` (EOD Historical Data is the licensed alternative).
* SEC: one primary document per filing by default; exhibits are reachable via the
  `filingIndex` URL in the sidecar, or set `SEC_FULL_SUBMISSION="true"`.
