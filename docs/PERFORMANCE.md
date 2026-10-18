# Performance budgets

`npm run bench` measures the software against the budgets in `perf/budgets.json` and writes the figures to
`perf/results.json`. It exits with status 1 when any budget is exceeded, so a regression fails the run rather than
going unnoticed. It is not part of `npm run verify`: it needs a built tree and a free port pair, and it starts a server
and a browser.

## What is measured

| Group | Measure | Budget | Measured (4 runs) |
|---|---|---|---|
| Bundle (gzip) | Entry script, as `index.html` names it | 250 KB | 228.6 KB |
| Bundle (gzip) | Initial load: entry plus the chunks it preloads | 270 KB | 246.4 KB |
| Bundle (gzip) | All JavaScript | 950 KB | 861 KB |
| Bundle (gzip) | All CSS | 130 KB | 116.5 KB |
| API, 4,014 assets | Asset list, p95 of 30 requests | 1200 ms | 400–646 ms |
| API, 4,014 assets | Asset detail, p95 of 30 requests | 300 ms | 14–20 ms |
| Page (Chromium) | Sign-in page, DOMContentLoaded | 3000 ms | 309–378 ms |
| Page (Chromium) | Asset register, first rows shown | 8000 ms | 1.5–4.7 s |

The bundle figures are read from `apps/web/dist` after `npm run build`: the entry is the script `index.html` names, and the initial load adds the chunks it preloads. The benchmark once matched the entry by file name, which can pick up another `index-*` chunk; the method now reads the page, so the entry it reports is the one a browser loads. The API and page figures come from a
temporary installation seeded with a synthetic register of 4,000 assets (tags `BENCH-00000` onward), started from the
built server. Its data directory is removed when the run ends. The measured ranges cover the runs on the reference
sandbox since the asset-detail change described below. The committed `perf/results.json` holds the final run.

Earlier, before the detail query was narrowed, the same sandbox measured the detail p95 at 538 ms and the list p95 at
439 ms. The list figure did not change materially; the detail figure fell by about 30 times.

## Why the budgets sit where they do

A budget is set above the worst value measured on the reference machine, with headroom for variance on a shared
host. A budget is not a target to aim for.

- **Detail, 300 ms.** Fifteen to twenty-one times the measured 14–20 ms. It is set below the 538 ms the detail took when it
  loaded the whole register, so a return to that behaviour fails the run.
- **List, 1200 ms.** About twice the worst measured p95 (646 ms).
- **Sign-in, 3000 ms.** About eight times the worst measured value (378 ms).
- **First rows, 8000 ms.** About 1.7 times the worst measured value (4.7 s). This budget has the least headroom in
  relative terms, because the measurement is the slowest and the most variable.
- **Bundle budgets.** Each sits about 9–12 percent above the current size, so a new dependency that adds a noticeable
  amount of JavaScript fails the run and becomes a deliberate decision.

## What the asset detail change did

The detail used to load the whole register and build a view of every asset to find one. It now loads the asset, the
assets that depend on it, and the assets those depend on, through a recursive query over the dependency table, plus
everything those depend on upstream, since availability follows the whole chain. Relations the person may not see are
filtered by reading only the access fields of the records named, not by loading every record. The asset, access, stock,
import and incident-report test files were run against the change: 44 tests, all passing.

## Limits of these figures

- **Quiet installation.** The API numbers are taken with no simulator running. The embedded database serialises
  queries on one connection, so a live ingest stream queues reads behind it. Latency with a busy ingest is higher than
  these figures and has not been measured. The cause is not fully diagnosed; the likely contributors are that stream and
  background timers on the development server, not the request handlers themselves.
- **One user.** The figures are for sequential requests from one client. No concurrency or load test has been run.
- **Software rendering.** Page timings use Chromium with software WebGL (SwiftShader), not a GPU. Real hardware renders
  faster; these figures are conservative for rendering and are not a measurement of a deployed machine.
- **Reference machine.** The sandbox has 4 CPUs and Node 22.22. Budgets are sized for that machine, and a slower host
  should re-measure before it changes a budget.
- **Synthetic register.** The benchmark adds 4,000 generated assets, all in one category and with no dependencies, to
  the demonstration register. The detail is timed on one demonstration asset (`GEN-1`) whose chain length is not
  recorded. A real register with deep dependency chains will cost more per detail. The detail reads the chains around
  the asset, not the whole register, but that has not been measured on a deep chain.
- **Not measured.** Write throughput, the ingest pipeline, vision and camera processing, cold start, and memory use over
  a long session.

## Running it

Build first, then run the benchmark:

    npm run build
    npm run bench

Options:

    BENCH_PAGE=0 npm run bench          skip the browser measurements (bundle and API budgets still run)
    PLAYWRIGHT_CHROMIUM=/path/chromium  use a specific Chromium for the page measurements

The benchmark starts its server on ports 4960 and 4961; both must be free. The results file is overwritten on each run,
and its `measuredAt` field records when it was produced. To change a budget, change `perf/budgets.json` in the same
commit as the measurement that justifies it.
