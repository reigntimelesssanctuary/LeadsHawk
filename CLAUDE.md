# CLAUDE.md — LeadsHawk

This file is the orientation guide for any future Claude (or human) working on
this codebase. It captures what the project is, how it's wired together, the
design choices baked in, and the user's collaboration preferences.

---

## 0. v1.1 — Live Monitor architecture (added 2026-05-23)

LeadsHawk now has a **4-stage funnel** that runs 24/7 instead of (or alongside) the cron-based scan. The funnel pushes expensive LLM calls to the very end so monitoring can scale without burning API credits:

```
[Sources]  →  [Pre-filter]      →  [Triage LLM]              →  [Deep qualify]
 RSS/Atom     local embeddings    Claude Sonnet 4.6           Perplexity sonar-pro
 free         free, on-device     ~$0.0001 per candidate      ~$0.02 per strong item
```

**Time-zone note for the Live Monitor "Fetched" column:** SQLite's
`datetime('now')` writes UTC strings without a timezone marker — JS Date
parses those as local time, which is wrong. `fmtDateSGT()` in `lib/api.ts`
appends `'Z'` to bare SQLite datetimes and renders them in
`Asia/Singapore` with `hour12: true` (AM/PM). Used on the Live Monitor
table's Fetched column. Other date displays still use `fmtDate` /
`fmtDateShort` (system locale, no forced zone) — if you need to fix those
too, switch them to `fmtDateSGT` or generalise the helper.

- **Stage 1 — Ingest** (`src/main/monitor/ingest.ts`): RSS/Atom poller with adaptive cadence + ETag / If-Modified-Since. Per-source poll intervals, exponential backoff on consecutive empty polls (up to 8×). Default seeded sources: TechCrunch Enterprise, Reuters Tech, The Register Networking, Dark Reading, three Google News queries (outages, CIO/CISO appointments, vulnerabilities), and SEC EDGAR 8-K. All raw items land in `signal_items` with status `'new'`.
- **Stage 2 — Embed + filter** (`src/main/monitor/embed.ts`): `@huggingface/transformers` running `Xenova/all-MiniLM-L6-v2` (384-dim, ~22 MB) **on-device, free**. We pre-compute one embedding per signal bullet per product (`products.signal_embeddings` JSON column) at research time. Items are embedded on arrival, scored against every researched product's vector set via cosine similarity, and the best match is recorded. Items above `embedSimilarityThreshold` become `'candidate'`; below become `'filtered'`.
- **Stage 3 — Triage** (`src/main/monitor/triage.ts`): Claude **Sonnet 4.6** call per candidate, scoped to the matched product. Returns `{decision: rejected|weak|strong, confidence, reason}`. Strong → continue; weak / rejected → tagged and stopped.
- **Stage 4 — Qualify** (`src/main/monitor/qualify.ts`): Perplexity `sonar-pro` deep dive per `triaged_strong` item. Honors per-product `scan_rules`. Creates an `opportunities` row on success and fires a macOS native notification.

Orchestrator (`src/main/monitor/index.ts`):
- `startMonitor()` / `stopMonitor()` driven by `settings.liveMonitoringEnabled`.
- Two interval timers: 60s for the source poll cycle, 30s for the pipeline cycle.
- Pipeline processes up to 5 items per stage per cycle to avoid spiking CPU / API.
- `getMonitorStatus()` returns funnel counts (last-24h) plus embedder readiness state.
- Survives window-close on macOS (window-all-closed no longer quits); fully quits only via `app.quit()`.

**Run loop:** when the app starts, if `settings.liveMonitoringEnabled` is true the monitor auto-resumes. Settings has an "Open at login" toggle that calls `app.setLoginItemSettings({ openAtLogin, openAsHidden: true })` so the user can have true 24/7 coverage as long as their Mac is on.

## 1. What LeadsHawk is

A **Mac-native desktop app** that autonomously hunts corporate B2B sales
opportunities for the brands and products the user sells.

The pipeline is:

1. **Portfolio ingestion** — user adds brands & products and dumps knowledge
   (PDFs, PowerPoints, web links, free-text notes) into a per-brand knowledge
   base.
2. **Deep research** — Claude analyzes each product against its knowledge base
   and produces a competitive dossier (description, category, use cases,
   competitors, differentiators, signals to watch, narrative summary). Brand
   summaries roll up from products.
3. **Autonomous scanning** — on a cron schedule (default every 6h), LeadsHawk
   iterates over each researched, scan-enabled product and asks Perplexity
   to find recent real-world events that match **that product's own
   auto-derived signals** (the `signals` bullets produced by deep research).
   The user does not configure signals manually — the app determines them
   from product understanding. Optional power-user "custom topics" can be
   added in Signal Config → Advanced.
4. **Qualification** — each signal is sent to Claude with the full portfolio
   context. The model decides if it's a real buying opportunity, picks the
   matching brand+product, and produces background, use case, sales angle, and
   a one-line signal summary. Items below a confidence threshold are dropped.
5. **Brief generation** — on demand, Claude writes a one-page sales brief with
   talking points and a draft outreach email.

Everything runs locally. The only outbound traffic is to the Anthropic API and
the news sources the user configures.

---

## 2. Tech stack

| Layer | Tech |
|---|---|
| Shell | Electron 33 (Mac-native window, `titleBarStyle: 'hiddenInset'`) |
| Main process | TypeScript, Node, ESM |
| Renderer | React 18, TypeScript, Vite |
| Styling | Tailwind CSS + handwritten utility classes in `index.css` |
| Icons | `lucide-react` |
| Database | `better-sqlite3` (synchronous, stored under `app.getPath('userData')/data/leadshawk.db`) |
| Settings | `electron-store` (`settings.json` in userData) |
| LLM (research) | **Perplexity** `sonar-deep-research` |
| LLM (cron scans + live-monitor deep qualify) | **Perplexity** `sonar-pro` |
| LLM (live-monitor triage) | **Anthropic** `claude-sonnet-4-6` (per-candidate yes/no/strong) |
| LLM (sales brief) | **Anthropic** Claude (default Opus 4.7) |
| Embeddings (live-monitor pre-filter) | **`@huggingface/transformers`** running `all-MiniLM-L6-v2` on-device — no API |
| News discovery (live monitor) | `rss-parser` over RSS/Atom + Google News RSS, with ETag/If-Modified-Since |
| News discovery (cron scans) | Perplexity's built-in live web search |
| Document parsing | `pdf-parse` (PDF), inline XML extraction for PPTX/DOCX via `yauzl` (optional), `node-html-parser` (HTML/URL) |
| Scheduling | `node-cron` |
| Build | `electron-vite` (separate main / preload / renderer Vite builds) |
| Packaging | `electron-builder` → DMG (Apple Silicon arm64; x64 disabled to keep build fast) |

**Node version:** developed/tested against Node 25.6.0. Electron 33 ships its
own Chromium runtime so the app's runtime is Electron's, not the host Node.

---

## 3. Folder structure

```
LeadsHawk/
├── CLAUDE.md                      ← this file
├── README.md                      ← end-user install + usage docs
├── package.json                   ← deps, scripts, electron-builder config
├── package-lock.json
├── tsconfig.json
├── electron.vite.config.ts        ← separate Vite configs for main/preload/renderer
├── tailwind.config.js
├── postcss.config.js
├── .gitignore
├── data/                          ← runtime data (mostly gitignored)
│   ├── brands/                    ← per-brand upload folders (dev-mode only)
│   ├── logs/
│   └── leadshawk.db               ← gitignored; runtime DB lives under
│                                    ~/Library/Application Support/LeadsHawk/data/
├── out/                           ← build output (gitignored)
│   ├── main/index.js
│   ├── preload/index.mjs
│   └── renderer/                  ← index.html + assets
├── release/                       ← DMGs from `npm run dist:mac` (gitignored)
└── src/
    ├── shared/
    │   └── types.ts               ← TypeScript types shared between main & renderer
    ├── main/                      ← Electron main process (Node)
    │   ├── index.ts               ← App entry: BrowserWindow, IPC, scheduler, live monitor auto-resume
    │   ├── db.ts                  ← SQLite open + migrations (incl. signal_items, monitor_sources, products.signal_embeddings)
    │   ├── settings.ts            ← electron-store wrapper for user settings
    │   ├── llm.ts                 ← Anthropic client wrapper (sales brief)
    │   ├── perplexity.ts          ← Perplexity client (research + cron scans + deep qualify)
    │   ├── knowledge.ts           ← File extraction (PDF/PPTX/DOCX/TXT/HTML) + URL fetch+strip
    │   ├── research.ts            ← Product research pipeline; triggers signal_embeddings refresh
    │   ├── scanner.ts             ← Cron-based scan pipeline (Perplexity, per-product)
    │   ├── scheduler.ts           ← node-cron wrapper. Reads scanCron + scanEnabled from settings
    │   ├── dispatch.ts            ← Sales brief generator + dispatch log
    │   ├── ipc.ts                 ← All ipcMain.handle() endpoints + seedDefaults()
    │   └── monitor/               ← v1.1 Live Monitor — the 4-stage funnel
    │       ├── index.ts           ← orchestrator (start/stop, poll + pipeline timers, notifications)
    │       ├── ingest.ts          ← adaptive RSS/Atom poller + default source seeding
    │       ├── embed.ts           ← @huggingface/transformers wrapper + product signal vectors
    │       ├── triage.ts          ← Claude Sonnet 4.6 yes/no/strong per candidate
    │       └── qualify.ts         ← Perplexity sonar-pro deep dive per strong candidate
    ├── preload/
    │   └── index.ts               ← contextBridge exposing the `window.lh` API to the renderer
    └── renderer/                  ← React app (Vite root = this folder)
        ├── index.html
        └── src/
            ├── main.tsx           ← React mount
            ├── App.tsx            ← Sidebar + page router (useState, no react-router)
            ├── index.css          ← Tailwind directives + design tokens + component classes
            ├── types.d.ts         ← Declares `window.lh` typed from preload export
            ├── lib/
            │   └── api.ts         ← `window.lh` helpers + date formatters + openExternal
            ├── components/
            │   ├── Sidebar.tsx    ← Dark sidebar with logo, nav, version footer
            │   ├── StatCard.tsx   ← Dashboard stat tile (label, big number, chip)
            │   ├── Switch.tsx     ← Purple pill toggle (used in BrandsProducts, LiveMonitor)
            │   └── Modal.tsx      ← Generic modal dialog
            └── pages/
                ├── Dashboard.tsx
                ├── LiveMonitor.tsx ← v1.1 — on/off toggle, funnel counts, items, sources
                ├── ScanJobs.tsx
                ├── SignalConfig.tsx
                ├── BrandDispatch.tsx
                ├── BrandsProducts.tsx
                ├── Archive.tsx
                ├── Settings.tsx
                └── OpportunityDetail.tsx
```

---

## 4. What each file does

### Main process (`src/main/`)

- **`index.ts`** — Electron app entry. Creates the main BrowserWindow at
  1440×900 (min 1100×720) with `titleBarStyle: 'hiddenInset'` (Mac traffic
  lights overlay the sidebar). Loads the renderer either from
  `process.env.ELECTRON_RENDERER_URL` in dev or from
  `out/renderer/index.html` in production. Opens external links in the
  default browser. After `app.whenReady()`: opens the DB, registers IPC,
  seeds default signal sources, starts the scheduler.

- **`db.ts`** — Opens `better-sqlite3` against
  `app.getPath('userData') + '/data/leadshawk.db'` with WAL mode and FK
  enforcement. The `migrate()` function creates all tables idempotently
  (`CREATE TABLE IF NOT EXISTS`).

  **Schema:**
  - `brands(id, name UNIQUE, description, positioning, competitive_summary, scan_enabled, …)`
    — `scan_enabled` (default `1`): when `0`, ALL of the brand's products are excluded from scans regardless of their own toggle.
  - `products(id, brand_id→brands, name, description, category, use_cases, competitors, differentiators, signals, research_status, research_summary, scan_enabled, …)`
    — `scan_enabled` (default `1`) toggles whether autonomous scans run for this product. Added via idempotent `addColumnIfMissing` in `db.ts` so old DBs upgrade in place.
  - `knowledge_items(id, brand_id, product_id?, kind: 'file'|'link'|'note', title, source, content, status, …)`
  - `signal_sources(id, name, kind: 'google_news'|'rss'|'query', config JSON, enabled, …)`
  - `scan_jobs(id, cron, enabled, last_run_at, last_status, last_results, …)`
  - `scan_runs(id, started_at, finished_at, status, items_scanned, opportunities_created, log, …)`
  - `opportunities(id, brand_id?, product_id?, company, industry, headline, source_url, source_title, source_published_at, confidence, status: 'open'|'qualified'|'disqualified'|'archived', background, use_case, angle, signal_summary, raw_signal, …)`
  - `dispatch_log(id, opportunity_id, target, payload, result, …)`
  - `seen_urls(url PRIMARY KEY, seen_at)` — dedupe across scans
  - `scan_rules(id, product_id, kind: 'include'|'exclude', text, enabled, created_at)` — per-product user-defined hard constraints injected into that product's scan prompt. `product_id` added via `addColumnIfMissing`; rows are deleted when their product is deleted (manual cleanup in `products:delete`).

- **`settings.ts`** — Thin wrapper around `electron-store`. Persists:
  - `perplexityApiKey` (research + scan)
  - `perplexityResearchModel` (default `sonar-deep-research`)
  - `perplexityScanModel` (default `sonar-pro`)
  - `scanRecency` (default `week`)
  - `anthropicApiKey` + `model` (Claude, used only for sales-brief
    generation in `dispatch.ts`; default model `claude-opus-4-7`)
  - `scanCron` (default `0 */6 * * *`), `scanEnabled` (default `false` —
    user must opt in)
  - `minConfidence` (default `0.55`), `maxItemsPerScan` (default `30`)

- **`llm.ts`** — Anthropic (Claude) client. **Now used only by `dispatch.ts`
  for sales-brief generation.** Exposes `complete()` and `completeJson<T>()`.

- **`perplexity.ts`** — Perplexity API client. No SDK dependency — just
  `fetch` against `https://api.perplexity.ai/chat/completions`. Supports:
  - `model` selection (default `sonar-pro`)
  - `searchRecency` (`day` / `week` / `month` / `year`)
  - `jsonSchema` → wraps the call with `response_format: json_schema` for
    structured output
  - `searchDomainFilter` (max 10 domains)
  - Returns `{ text, json, citations, usage, raw }`.
  - `tryParseJson<T>()` strips `<think>` blocks (from reasoning models) and
    code fences, then falls back to outer brace extraction.

- **`knowledge.ts`** —
  - `extractFromFile(path)`: PDF→`pdf-parse`; TXT/MD→raw read;
    HTML→`node-html-parser` text; PPTX/DOCX→optional `yauzl` to crack the
    archive and strip XML tags (gracefully degrades to a placeholder if
    `yauzl` is unavailable); anything else→placeholder.
  - `fetchUrl(url)`: User-Agent-spoofed fetch, strips
    `<script>/<style>/<nav>/<footer>/<header>/<svg>/<form>`, prefers
    `<main>` or `<article>` content. Caps output at 50k chars.

- **`research.ts`** — `researchProduct(productId)` (uses **Perplexity**):
  1. Marks product `research_status = 'researching'`.
  2. Pulls up to 20 most recent indexed knowledge items for the brand.
  3. Calls Perplexity with `sonar-deep-research` (default) and a JSON
     schema requiring `description, category, use_cases, competitors,
     differentiators, signals, research_summary`. Perplexity does its own
     multi-step web research and synthesizes it with the internal
     knowledge.
  4. Persists the dossier, marks `ready`.
  5. Calls Perplexity again for a tight 150-word brand-level
     `competitive_summary`. If this secondary call fails it's swallowed —
     the brand summary is a nice-to-have, not a hard requirement.
  6. On any failure the product is set to `research_status = 'error'`.

- **`scanner.ts`** — The core autonomous loop (uses **Perplexity**, no RSS).
  `buildGuardrails(productId)` reads that product's enabled `scan_rules`
  and formats a block: `include` rules as ALL-must-pass, `exclude` rules
  as ANY-blocks. The block is told to outrank everything else and to
  return an empty `opportunities` array if nothing satisfies the rules.
  It's prepended to each product's Pass-1 prompt. Pass 2 (custom topics)
  gets no guardrails.

  **Pass 1 — auto signals from products (primary).**
  - Iterate over every product where `research_status='ready'`,
    `scan_enabled=1`, its brand's `scan_enabled=1`, and `signals` is
    non-empty.
  - `buildGuardrails(productId)` pulls that product's own enabled
    `scan_rules` and injects them as hard constraints into the prompt.
  - For each such product, send Perplexity a tightly-scoped prompt that
    includes only **that product's** context: brand, name, category,
    description, use cases, differentiators, and the bulleted signals to
    watch for.
  - Perplexity returns candidates with a `matched_signal` field (which
    specific bullet the opportunity matches), `source_url`, `confidence`,
    etc.
  - Per-product quota: `max(3, min(10, ceil(maxItemsPerScan / 3)))` so a
    portfolio of N products gets ~N×5 candidates per scan, not unbounded.

  **Pass 2 — optional custom topics (advanced).**
  - For each enabled `signal_sources` row, send Perplexity the full
    portfolio + the topic string and ask the model to also pick which
    brand/product matches (since custom topics aren't tied to a product
    upfront).
  - This pass only runs if the user has added any custom topics in
    Signal Config → Advanced. There are no auto-seeded sources anymore.
  - Custom topics get **no** include/exclude guardrails — those rules are
    per-product and a custom topic isn't bound to one product.

  Both passes share the same `insertCandidates()` helper which dedupes via
  `seen_urls`, enforces `minConfidence`, and inserts into `opportunities`
  with status `'open'`.

- **`scheduler.ts`** — `startScheduler()` reads cron + enabled flag from
  settings and registers a `node-cron` task. `restartScheduler()` is
  called from the settings IPC handler whenever the user changes either
  field, so changes take effect immediately.

- **`dispatch.ts`** —
  - `buildBrief(opportunityId)` produces a Markdown one-pager with
    sections *Why now / The fit / Recommended approach / Talking points /
    Draft outreach email* (subject + ≤120-word body).
  - `recordDispatch()` is a stub for future outbound integrations (Slack,
    email, CRM webhooks); for now it just logs into `dispatch_log`.

- **`ipc.ts`** — Registers every `ipcMain.handle('namespace:action', …)`
  endpoint. Namespaces: `settings`, `dashboard`, `brands`, `products`,
  `knowledge`, `sources`, `scan`, `opps`, plus a top-level
  `openExternal`. Also `seedDefaults()` which on first run inserts four
  signal sources (enterprise IT outages, CIO/CISO changes, Cisco issues,
  cloud migrations) and one default scan job row.

### Preload (`src/preload/index.ts`)

A typed `contextBridge.exposeInMainWorld('lh', …)` that mirrors every IPC
endpoint into a tree the renderer can call: `window.lh.brands.list()`,
`window.lh.scan.run()`, etc. The renderer never touches `ipcRenderer`
directly.

### Renderer (`src/renderer/`)

- **`App.tsx`** — Holds two pieces of state: the active sidebar `page` and an
  optional `oppId` (when set, the OpportunityDetail view overlays whichever
  page is active). No router library — just a tag-soup conditional render. A
  top 28px-tall drag region under the macOS traffic lights leaves room for
  window controls.

- **`components/Sidebar.tsx`** — Dark vertical nav. Active item is highlighted
  with the LeadsHawk purple. Whole sidebar is a `-webkit-app-region: drag`
  zone; the nav buttons themselves are `.no-drag`. Version `v1.0.0` lives in
  the bottom-left.

- **`components/StatCard.tsx`** — A bordered card with a tiny uppercase
  label, a large number, and a colored chip ('Open', 'Qualified',
  'Disqualified', 'Brands').

- **`components/Modal.tsx`** — Simple overlay modal with a header bar and a
  scrollable body, used for Add Brand / Add Product / Add Note / Add Link /
  Add Source.

- **`pages/Dashboard.tsx`** — Header ("Dashboard / Pipeline overview …"),
  four stat cards in a row, the "Last Scan" panel with the **Run Scan Now**
  purple button, then the "Open Opportunities" table. Each row resolves its
  brand and product names asynchronously via `window.lh.brands.get` /
  `products.get`.

  **Bulk select + delete:** every row has a checkbox, the header has a
  master select-all (with indeterminate state). When ≥1 rows are selected
  a contextual *Delete N* button appears next to the section title. Backed
  by `opps:deleteMany(ids[])` which runs the delete in a single SQLite
  transaction.

  **Scan Type column:** derives whether the opportunity came from the cron
  scanner (*Manual Scan*) or the live monitor (*Live Monitor*) by parsing
  `opportunities.raw_signal` JSON (`source` starts with `live_monitor`) and
  falling back to `source_title.includes('live monitor')`.

  The Actions column has **View / Source / Delete** — Delete confirms,
  calls `opps.delete(id)` (which also clears `dispatch_log` rows), and
  refreshes.

- **`pages/ScanJobs.tsx`** — Schedule editor (cron + enable toggle +
  presets: Every hour / 6h / Twice daily / Daily 9am), manual "Run Scan
  Now" panel, and a paginated history of `scan_runs` with click-through to
  view logs in a full-screen overlay.

- **`pages/SignalConfig.tsx`** — Two sections:
  1. **Auto-derived signals (primary).** Lists every researched product
     with an enable/disable checkbox + an expand caret. Expanding shows
     (a) the bulleted signal list captured by deep research and
     (b) a **per-product "Scan guidance"** sub-panel — two columns
     (Always include / Always exclude) of free-text rules persisted in
     `scan_rules` scoped to that product. Each rule has an enable
     checkbox + delete. These are HARD CONSTRAINTS injected into that
     product's scan prompt.
  2. **Advanced — custom topics (collapsed by default).** Optional
     free-form Perplexity search topics. Add with a single-form modal
     (`name` + `query`). These rows live in `signal_sources` and feed
     scanner Pass 2.

- **`pages/BrandsProducts.tsx`** — Two-pane layout. Left: 240px brand list.
  Right: the selected brand's panel containing:
  (a) editable brand metadata + competitive summary + an **"Include in
  scans" Switch** for the brand;
  (b) products list, each product card with a **"Scan" Switch** (disabled
  when the brand is excluded), per-product "Run research" button,
  collapsible dossier details, AND a **"Product knowledge" sub-section**
  with its own Upload / Add Link / Add Note buttons + inline list of
  attached items (added v1.1.1). Items added here have
  `knowledge_items.product_id` set;
  (c) a separate **"Brand-level Knowledge"** card with its own
  Upload / Add Link / Add Note buttons that creates items with
  `product_id IS NULL`.

  The `noteTarget` / `linkTarget` state in `BrandPanel` is `false | null | number`
  — `false` = modal closed, `null` = brand-level, `<number>` = product-level
  with that product's id. The `AddNoteForm` / `AddLinkForm` modals accept an
  optional `productId` + `productName` and show a "Attaching to product X"
  hint when product-scoped.

  Brand/product scan toggles write `brands.scan_enabled` /
  `products.scan_enabled` and are the same fields surfaced as checkboxes on
  the Signal Config page.

- **`components/Switch.tsx`** — Small purple pill toggle. Props:
  `checked`, `onChange(bool)`, optional `label`, optional `disabled`.

- **`pages/BrandDispatch.tsx`** — Table of `status='qualified'`
  opportunities, ready for outreach.

- **`pages/Archive.tsx`** — Filtered view of `disqualified` / `archived` /
  all closed opportunities.

- **`pages/Settings.tsx`** — Three cards:
  1. **Perplexity API** — API key + research-model picker
     (`sonar-deep-research` / `sonar-reasoning-pro` / `sonar-pro`) + scan-model
     picker (`sonar-pro` / `sonar-reasoning-pro` / `sonar`) + recency window
     (day/week/month).
  2. **Anthropic API** — API key + model picker (Opus / Sonnet / Haiku),
     used only by *Generate brief*.
  3. **Scanner tuning** — minimum confidence, max opportunities per source.

- **`pages/OpportunityDetail.tsx`** — Header card with company name,
  industry, summary, brand/product/status/confidence chips, and three
  status buttons (Qualify / Disqualify / Archive). Below: a 2-column grid of
  Background / Use case / Recommended angle / Source cards. At the bottom:
  the *Generate brief* button which streams a Claude-generated Markdown
  brief into a `prose-output` panel.

---

## 5. Design choices (matches the screenshot exactly)

### Color tokens (defined in `tailwind.config.js` and `index.css`)

| Token | Hex | Used for |
|---|---|---|
| `bg` | `#f7f7fa` | Main content background |
| `surface` | `#ffffff` | Cards |
| `sidebar` | `#1c1d28` | Sidebar background |
| `sidebarHover` | `#2a2b38` | Sidebar item hover |
| `primary` | `#6c5cf2` | "Run Scan Now" button, active sidebar item, focus rings |
| `primaryHover` | `#5a48ec` | Primary hover state |
| `ink` | `#111827` | Default text |
| `muted` | `#6b7280` | Secondary text, labels |
| `border` | `#e5e7eb` | Card/table borders |

Sidebar tagline ("B2B Signal Intelligence") uses `#a78bfa` (Tailwind violet-400).

### Chip palette

- `chip-open` — amber (`#fef3c7` / `#92400e`)
- `chip-qualified` — green (`#d1fae5` / `#065f46`)
- `chip-disqualified` — red (`#fee2e2` / `#991b1b`)
- `chip-archived` — indigo (`#e0e7ff` / `#3730a3`)
- `chip-brand` — violet (`#ede9fe` / `#5b21b6`)
- `chip-muted` — gray (`#f3f4f6` / `#4b5563`)

### Typography

System fonts only (no web fonts):
```
-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif
```
Anti-aliasing: `-webkit-font-smoothing: antialiased`. Default text size in
the UI is 14px; page headings (`.h-page`) are 24px/700, section headings
(`.h-section`) are 16px/600, card headings (`.h-card`) are 15px/600. The
`.label` utility is uppercase 11px/600 with 0.06em letter-spacing — used
for stat-card labels and form labels.

### Layout

- Fixed-width 240px sidebar + flexible main pane. Main pane scrolls; the
  sidebar does not.
- A 28px draggable strip sits at the top of the main pane so the macOS
  traffic-light buttons (visible via `titleBarStyle: 'hiddenInset'`) have
  somewhere to live.
- All content cards use a 12px radius, 1px `#e5e7eb` border, and a soft
  two-layer shadow (`shadow-card`).
- Buttons:
  - `.btn-primary` — purple, 8px radius, used for primary CTAs ("Run Scan
    Now", "Save", "Add Brand").
  - `.btn-ghost` — white with gray border, 6px radius, used for
    secondary/icon actions.
  - `.btn-danger` — white with red border + red text, used for destructive
    actions (Delete).
- Tables use a class-name convention `table.lh` — sticky-looking header on
  `#fafafa`, 12px column padding, row hover background `#fafafa`, no
  borders between rows beyond a 1px `#f3f4f6` divider.

### Window chrome

Frameless-inset Mac window (`titleBarStyle: 'hiddenInset'`) with a 1c1d28
background color so the launch flash matches the sidebar.

---

## 6. Pages / sections that exist

1. **Dashboard** — pipeline stats, last scan banner, open opportunities table
2. **Scan Jobs** — schedule editor + manual scan + run history with logs
3. **Signal Config** — list/add/enable Google News & RSS sources
4. **Brand Dispatch** — qualified opportunities awaiting outreach
5. **Brands & Products** — portfolio editor + knowledge base + product research
6. **Archive** — disqualified and archived opportunities
7. **Settings** — API key, model, scanner tuning
8. **Opportunity Detail** — overlay shown when any opportunity row is clicked

---

## 7. Build / run / package commands

```bash
npm install        # installs deps + electron-rebuilds better-sqlite3 against Electron's Node
npm run dev        # electron-vite dev — hot-reload renderer + main
npm run build      # produces out/{main,preload,renderer}
npm run dist:mac   # full build + electron-builder → release/LeadsHawk-1.0.0-arm64.dmg
```

The `dist:mac` target currently produces only arm64 (Apple Silicon). To also
produce x64, change `"arch": ["arm64"]` to `["arm64", "x64"]` in the
`build.mac.target` block of `package.json`. The build is **not** code-signed
(`identity: null`); first launch on macOS requires right-click → Open.

---

## 7a. Which LLM does what

| Feature | API | Default model | Why |
|---|---|---|---|
| Product *Run research* | **Perplexity** | `sonar-deep-research` | Multi-step, live web search; cites sources |
| Autonomous scan jobs | **Perplexity** | `sonar-pro` | One call per researched product, anchored to that product's own auto-derived signals (no manual signal configuration required) |
| Brand competitive summary roll-up | **Perplexity** | `sonar-deep-research` | Shares context with research |
| Sales brief (*Generate brief*) | **Anthropic Claude** | `claude-opus-4-7` | Pure writing task, no research needed |

User asked (2026-05-20) to swap scans + research from Claude to Perplexity. Brief generation stayed on Claude because it wasn't part of that ask.

Later same day, user asked to make signals fully autonomous — the app derives signals from product research instead of requiring manual configuration. Scanner now iterates over researched products and uses each product's `signals` field as the search anchor for that product's scan pass.

**v1.1 (2026-05-23):** Live Monitor added — 24/7 ingestion → on-device embedding pre-filter → Claude Sonnet 4.6 triage → Perplexity deep qualify. See section 0.

**v1.1.1 (2026-05-23):** Dashboard bulk-select + Scan Type column; Live Monitor Fetched timestamps in SGT with AM/PM; per-product knowledge actions (Upload / Add Link / Add Note) on every product card. `research.ts` now prioritises product-scoped knowledge when researching that product.

**v1.1.2 (2026-05-23):** Custom app icon — gold circuit-pattern hawk on black. Source at `build/icon.png` (1254×1254), compiled to `build/icon.icns` and wired into `package.json > build.mac.icon` so electron-builder bakes it into the bundle and DMG. Sidebar version string bumped from v1.0.0 → v1.1.2.

**v1.1.3 (2026-05-23):** Sidebar now shows the LeadsHawk logo (256×256 PNG at `src/renderer/src/assets/logo.png`, rendered at 48×48 with 12px radius) above the "LeadsHawk" text. Dashboard "Open Opportunities" table now scrolls horizontally instead of clipping — table has `minWidth: 1080` and the wrapping `.card` uses `overflowX: 'auto'`.

**v1.7.8 (2026-05-25):** Settings → Recency window gains "Last 12 months" option. `scanRecency` type widened to `'day' | 'week' | 'month' | 'year'`. Perplexity's `search_recency_filter` accepts `year` natively, so no API-layer change. Quick patch ahead of v1.8's per-brand/product override architecture.

**v1.7.7 (2026-05-25):** Fix — scan history timestamps (and any other `fmtDate` / `fmtDateShort` consumer) were rendering in the wrong timezone.

Root cause: SQLite's `datetime('now')` returns bare UTC strings like `"2026-05-25 04:44:35"` with no `Z` suffix. JS `new Date("2026-05-25 04:44:35")` parses that as local time, which is wrong. The `parseSqliteUtc()` helper (added in v1.1.1 for the Live Monitor "Fetched" column) already handled this correctly, but it was defined BELOW `fmtDate` / `fmtDateShort` and they weren't using it.

Fix in `src/renderer/src/lib/api.ts`:
- Hoisted `parseSqliteUtc()` above the formatters.
- `fmtDate` and `fmtDateShort` both now call `parseSqliteUtc()` and render via `toLocaleString('en-SG', { timeZone: 'Asia/Singapore', ... })`.
- `fmtDate` is 24-hour; `fmtDateSGT` stays 12-hour (AM/PM) for the Live Monitor where that cue is more useful.

Affects every date display in the app: Scan Jobs history (Started / Finished), Dashboard Last Scan banner, Opportunity Detail source-published-at, Live Monitor source last-poll, etc.

**v1.7.6 (2026-05-25):** Fix — `sonar-deep-research` responses (especially ~15KB+ ones) were failing JSON extraction even though the async call now completes cleanly.

Root cause: deep-research mixes reasoning prose with the final structured JSON output in ways the old `tryParseJson` didn't handle. The old extractor only stripped `<think>` tags at edges and looked for the outer-most {…} with naive index matching — which broke when there were nested or sequential JSON objects, embedded ```json fenced blocks, or non-tagged reasoning text between blocks.

Rewrite of `tryParseJson` in `perplexity.ts`:
1. Strip `<think>...</think>` AND `<thinking>...</thinking>` AND `<reasoning>...</reasoning>` (case-insensitive, multi-occurrence).
2. Extract content from every ```json (or plain ```) fenced block in the response. Try the largest first — if it parses, return.
3. Strip remaining fence markers and try direct parse.
4. Walk the cleaned string and collect every balanced `{...}` / `[...]` substring via proper brace-counting that respects strings + escapes. Sort by size descending, try each. The largest balanced block containing the expected schema almost always wins.

Helpers `extractBalancedBlocks(s)` and `findBalancedClose(s, idx)` added.

Diagnostic in `scanner.ts`: on parse failure, log the first 800 chars + last 200 chars of the response (whitespace-collapsed) so the user can paste the log and we can see what shape Perplexity actually returned. Previously the log just said "unparseable response (N chars)" with no info.

**v1.7.5 (2026-05-25):** Architectural: deep scan no longer runs Pass 2 (custom topics).

Rationale: custom topics are broad thematic searches that don't anchor on product knowledge, don't benefit from multi-step deep research, are failure-prone on `sonar-deep-research` (every custom topic timed out in v1.7.0–v1.7.3 deep runs), and are already covered by every-6h manual scans. Letting deep scans focus on per-product Pass 1 keeps the expensive model's budget on the work where it actually pays off.

`ScanOpts` gains `skipCustomTopics?: boolean`. `runDeepScan` sets it to `true`. `runScan` logs `Pass 2 (custom topics) skipped — not run in deep scans (they run in manual scans only).` when the flag is set. Manual scan is unchanged — still runs both passes.

**v1.7.4 (2026-05-25):** Crit fix — sonar-deep-research calls were failing at ~125s with `fetch failed` even after v1.7.3 extended the local timeout. Root cause: Perplexity's **synchronous** `/chat/completions` endpoint has a server-side gateway timeout (~120s) that kills long deep-research calls before the model finishes. Our local timeout extension didn't help because the connection was being closed by Perplexity's edge.

Fix: route any model matching `/deep-research/i` through Perplexity's async API instead:
- `POST /v1/async/sonar` with body `{ request: <sync-shape body> }` → returns `{ id, status }`
- `GET /v1/async/sonar/{id}` polled every 5 s until `status === 'COMPLETED'`
- Extract `response.choices[0].message.content`, `response.citations`, `response.usage` exactly as the sync flow does
- 20-minute polling cap (covers worst-case multi-step research)
- Each HTTP request is short, so the gateway timeout never trips

`perplexity.ts` refactored into `completePerplexitySync` + `completePerplexityAsync`, with the exported `completePerplexity` auto-routing based on `isLongRunningModel(model)`. Affected stages: `deep_scan`, `research`, `brand_research`, `brand_summary` (anything using `sonar-deep-research`). Cheap stages (`manual_scan` / `qualify` / `refresh_signals` using `sonar-pro`) stay on the sync endpoint.

**v1.7.3 (2026-05-25):** Crit fix — v1.7.2 wouldn't launch. `npm install undici` in v1.7.1 resolved to undici@8.x which calls `webidl.util.markAsUncloneable` (a Node 22.5+ API). Electron 33 ships Node 20.18.x, which lacks it. App crashed on startup at the require-time of undici's `lib/web/cache/cachestorage.js`. Pinned `undici: ^6.25.0` (same major as Electron's bundled undici). API shape (`Agent`, `fetch`) is identical so `perplexity.ts` needs no changes.

**v1.7.2 (2026-05-25):** UX: scan-inclusion toggles moved from Brands & Products to Scan Jobs.

New `ScanInclusionCard` on the Scan Jobs page (between Schedule and Manual run): lists every brand with its products as a hierarchical tree, each row with a Switch. Brand-level toggle still cascades — disabling a brand greys out and disables all its product toggles. Header shows live counts ("N/M brands active · X/Y products active").

BrandsProducts cleanup:
- Removed the brand "Include in scans" Switch from the BrandPanel header.
- Removed the per-product "Scan" Switch from each product card.
- Replaced with read-only chips (`scans on` / `scans paused`) with tooltip pointing to Scan Jobs → Scan inclusion.
- Updated the disabled-brand banner to point users to the new location.
- Removed unused `Switch` import.

Backend IPC (`brands:setScanEnabled`, `products:setScanEnabled`) unchanged — both pages still use the same handlers, just from different UIs.

**v1.7.1 (2026-05-25):** Bug fix — deep-research scans were failing with `fetch failed` on broad-domain products after ~5 minutes. Root cause: Node's bundled `undici` fetch has a default 5-minute `bodyTimeout`. Multi-step sonar-deep-research calls on broad topics (e.g. Zyeta / Renovation Services) legitimately exceed that. Replaced global `fetch` in `perplexity.ts` with explicit `undici` import + a custom `Agent` (bodyTimeout 12min, headersTimeout 60s). Added one-retry wrapper for transient network errors (`fetch failed`, `ECONNRESET`, `ETIMEDOUT`, etc.) — API errors (4xx/5xx with response body) are NOT retried. Added `undici` as a direct dependency.

**v1.7.0 (2026-05-25):** **Signal-first track enhancements (Track B of the dual-track architecture).** Closes the parallel-tracks design.

1. **Brand context in Live Monitor prompts.** Both `monitor/triage.ts` and `monitor/qualify.ts` now include the full brand block (category, description, positioning, target_icp, competitive_summary, brand signals, truncated research_summary) — same upgrade scans got in v1.6. Live monitor decisions now have the same foundational context as the cast-nets engine.
2. **Manual article intake.** New `monitor:intake` IPC accepts `{url, title?}`, fetches via the existing `fetchUrl()`, inserts a `signal_item` with `source_id=NULL`, and runs the full pipeline (embed → match → triage → qualify) **synchronously** via the new `processSingleItem(itemId)` export in `monitor/index.ts`. Returns a typed `IntakeOutcome` so the UI can show what happened. New `ManualIntakeCard` on the Live Monitor page with an inline URL input + result banner (qualified / triaged / filtered / error). Lets the user feed anything they've seen externally through the signal-first engine on demand.
3. **Bidirectional cross-match.** New `crossMatchRecent` in `scanner.ts` runs after every successful Pass-1 insert: embeds each fresh opportunity's headline+summary, compares against every OTHER scan-enabled product's cached signal embeddings, and creates up to 2 additional opportunities for products whose best similarity beats `embedSimilarityThreshold + 0.10`. Cross-match opportunities are tagged in `raw_signal.source = 'cross_match:from_product_<N>'` and reference `origin_opportunity_id`. Confidence is scaled by similarity (capped 0.30–0.95). Gated by a new `crossMatchEnabled` setting (default `true`). Dedupe is per-(product_id, source_url).
4. **Brand-level signals surfaced on Signal Config.** New top section showing each brand's research-derived brand-level signals (read-only; edit via brand edit modal or re-run brand research). Makes it visible what the v1.6 brand research generated and what feeds every scan prompt.

**v1.6.0 (2026-05-25):** **Knowledge-first scans (Track A of the dual-track architecture).** Cast-nets engine (manual + deep scans) now grounds on the full accumulated brand + product knowledge instead of being anchored to pre-derived signal bullets.

Schema additions (all idempotent):
- `brands.research_status` (default 'pending'), `research_summary`, `target_icp`, `category`, `signals`, `last_researched_at`.
- `products.last_researched_at`.
- `knowledge_items.indexed_at`.
- New `knowledge_chunks` table (id, item_id FK CASCADE, ord, text, embedding JSON, created_at) + index on item_id.

New modules:
- `src/main/knowledge-index.ts`: `chunkText` (~500-char chunks, 50-char overlap, sentence/paragraph-aware breaks), `chunkAndEmbedKnowledgeItem` (per-item, fire-and-forget), `retrieveRelevantChunks(query, brandId, productId?, k)` (cosine sim with small bonus for product-scoped chunks), `renderChunksBlock`, `backfillKnowledgeIndex` (one-time at boot).
- All knowledge inserts in `ipc.ts` (addNote / addLink / upload) now fire `chunkAndEmbedKnowledgeItem(id)` async.
- Boot path in `src/main/index.ts` schedules `backfillKnowledgeIndex` after 5s so existing knowledge items get indexed in the background.

Brand becomes a research subject:
- New `researchBrand(brandId)` in `research.ts` using `sonar-deep-research` with a `BRAND_RESEARCH_SCHEMA` (category, positioning, target_icp, competitive_summary, signals, research_summary). New `'brand_research'` LlmStage; new `brands:research` IPC; new `window.lh.brands.research(id)` preload mirror.
- `researchProduct` now sets `last_researched_at` and **stops the side-effect brand-summary regeneration** (fixes the historical bug where brand summaries got overwritten on every product re-research). The brand summary is now ONLY produced by `researchBrand`.

Scan prompt rewrite (the big one):
- `scanner.ts` Pass 1 prompt now includes: full brand block (category, description, positioning, target_icp, competitive_summary, brand signals, truncated research_summary), full product block (including `competitors` and truncated `research_summary` — both previously stored but invisible to scans), and **top-5 retrieved knowledge chunks** queried by `[brand.name, target_icp, product.name, description, signals].join('\n')`.
- SYSTEM prompt rewritten: signals are "guidance not constraint"; the model is told to USE accumulated knowledge to find quality opportunities.
- Task framing rewritten: "Using ALL of the context above…anchor on signals when they fit, but don't be limited to them. Use your full understanding of who we are and who we sell to."

UI:
- BrandPanel header gains a **"Run Brand Research"** button (Sparkles icon) next to Edit / Delete with status chip (`pending` / `researching…` / `dossier ready` / `error`).
- New `BrandResearchPanel` component replaces the old standalone competitive_summary card; shows status chip, optional "upload knowledge first" hint, and a collapsible dossier (Field grid for category / positioning / target_icp / signals / competitive_summary / research_summary).
- New `ReResearchBadge` component on both brand and product cards: shows yellow "Re-research recommended (N new)" when `MAX(knowledge_items.created_at) > last_researched_at`.

Cost note: brand research is a `sonar-deep-research` call (~$0.10-0.30 per brand). Run it once per brand, re-run when significant new knowledge is added (the yellow badge will tell you).

**v1.5.4 (2026-05-24):** URL hygiene for scanner output — "Source" links no longer dump the user on hallucinated URLs.

Root cause: Perplexity occasionally returns a `source_url` in the JSON that doesn't actually appear in its citations array (paraphrased, malformed, or invented). The old code accepted whatever string the LLM returned.

New module `src/main/url-hygiene.ts` with:
- `cleanUrl(raw)` — strips wrapping quotes/parens, trailing sentence punctuation, parses out markdown link form `[text](url)`, validates http/https, rejects placeholder hosts (`example.com` etc.), strips fragment.
- `pickBestSourceUrl(llmUrl, citations)` — returns `{ url, source }` where source is `'llm'` (LLM URL matched a citation, canonical compare), `'citation'` (substituted because LLM URL not in citations — falls back to host-match, then first citation), or `'llm_unverified'` (no citations available, returning LLM URL as-is or null).
- `dedupeCleanCitations(list)` — canonical-deduped list for UI display.

`insertCandidates` (scanner.ts) now:
- Threads `citations: string[]` through from the Perplexity response (both Pass 1 and Pass 2).
- Calls `pickBestSourceUrl` on every candidate. Candidates with no usable URL are dropped with `skip (no usable source_url)`.
- Logs substitution events as `~ substituted source_url with citation for X`.
- Persists the picked source's provenance + up to 8 alternative citations in `raw_signal.alt_sources` / `raw_signal.url_source`.

OpportunityDetail.tsx new `AlternativeSources` panel: shows a yellow info banner when the source was substituted or unverified, plus a clickable list of citations the user can try if the primary link is dead.

Live monitor unaffected — its `source_url` comes from the original RSS item (already grounded), not from any LLM.

**v1.5.3 (2026-05-24):** Bug fix — manual scan Pass 2 (custom topics) was producing leads for scan-disabled brands.

Root cause: `buildPortfolio()` enumerated ALL brands + products regardless of `scan_enabled`, so the Pass 2 prompt told the LLM about disabled brands and let it return `matched_brand` against them. Three-layer fix in `scanner.ts`:

1. **Pass 2 portfolio is now filtered to scan-enabled only** — `enabledBrands` + `enabledProducts` computed at the top of the block. If there are no enabled brands at all, Pass 2 is skipped entirely with a log line.
2. **Pinned custom topics whose product or brand is disabled are skipped** with `skipped — pinned product/brand is scan-disabled`.
3. **`matched_brand` / `matched_product` lookup uses only enabled lists**, so even if the model hallucinates a disabled brand name, it won't resolve.
4. **Defense-in-depth in `insertCandidates`**: any candidate whose attributed brand or product is scan-disabled is dropped with `skip (brand "X" is scan-disabled)` / `skip (product "Y" is scan-disabled)` log lines.

Pass 1 was unaffected — its `scanProducts` filter already correctly required `enabledBrandIds.has(p.brand_id)`. Live monitor also unaffected — `bestProductMatch` already joins on `b.scan_enabled = 1`.

`buildOwnBrandsBlock` deliberately keeps ALL brands (including disabled) — that's an identity rule (Juniper is still us even when we're not actively hunting their leads), not a scan-enable rule.

**v1.5.2 (2026-05-24):** Country column + filter on the Dashboard table. SortKey gains `country`; Filters gains a `country` string (exact match by name); new sticky-row dropdown populated from distinct non-null country values across the loaded set. Column sits between Industry and Brand to match the Excel column order. Table `minWidth` bumped 1180 → 1280 to accommodate; empty-state colSpan bumped 10 → 11.

**v1.5.1 (2026-05-24):** Country field on opportunities.

- New `opportunities.country TEXT` column (idempotent migration).
- `PplxOpportunity` (scanner.ts) and `QualifyResult` (monitor/qualify.ts) gain a `country: string | null` field; matching JSON schemas now require `country` with type `['string','null']` so the LLM can return null when unknown.
- Both insert paths (`insertCandidates` in scanner.ts and `qualifyItem` in monitor/qualify.ts) persist the country; whitespace-only strings are normalized to null.
- Excel export gains a **Country** column positioned between Industry and Brand (width 18).
- Existing opportunities show empty Country in exports; new opportunities from any of the three engines (manual scan, deep research scan, live monitor) populate it. Country is not surfaced in the Dashboard UI yet — easy follow-up if useful.

**v1.5.0 (2026-05-24):** Third scanning engine — twice-daily Deep Research scan.

- New settings: `deepScanEnabled` (default false), `deepScanCron` (default `0 9,21 * * *` — 9am & 9pm local), `deepScanModel` (default `sonar-deep-research`).
- New schema column: `scan_runs.kind` (`'manual'` default, `'deep'` for deep-scan rows). Idempotent backfill via `addColumnIfMissing`.
- `runScan()` refactored to take a `ScanOpts` object (`{ model, stage, kind, maxTokens, label }`). Default behavior unchanged — legacy callers still get sonar-pro + stage='manual_scan' + kind='manual'.
- New `runDeepScan()` thin wrapper: same pipeline (Pass 1 + Pass 2 + brand-self hygiene + disqualify learning + scan rules) but uses the deep model + 9000-token budget + stage='deep_scan' so spend dashboard tracks it separately.
- New `LlmStage` value `'deep_scan'` in `pricing.ts`.
- Scheduler manages **two** ScheduledTask instances — regular + deep — each tied to its own enabled flag. `restartScheduler()` tears down both and re-registers them.
- New IPC `scan:runDeep` + `window.lh.scan.runDeep()` for on-demand triggering.
- Settings page: new "Deep Research Scan" card with toggle, cron presets (Twice daily / Daily 9am / Every 12h / Weekly Mon 9am), and a deep-model picker.
- ScanJobs page: new "Run Deep Scan Now" button (greyer, secondary CTA) next to "Run Scan Now"; history table gains a "Kind" column with a purple `deep research` chip vs. grey `manual`.

**v1.4.0 (2026-05-24):** Dashboard usability + edit-in-place + brand-self fix.

1. **Default sort + sortable headers + per-column filters.** `opps:list` now returns rows in `datetime(created_at) DESC, id DESC` order. Dashboard rewritten to pre-fetch brands/products into maps (sync filter / sort, no per-row async lookup). Each column header is clickable to sort (toggle direction); a thin sticky filter row sits below the headers with: text inputs (company, industry, signal), select dropdowns (brand, product, scan type), and a min-confidence number input.
2. **Bulk Excel export.** `exceljs` added. New `opps:exportXlsx(ids[])` IPC builds a workbook (`src/main/export.ts`), opens a native save dialog, and writes the .xlsx. Columns: Date, Company, Industry, Brand, Product, Confidence (formatted as %), Signal summary, Background, Justified use case, Recommended sales angle, Source title, Source URL (as hyperlink), Source published. Header row is frozen + purple-tinted.
3. **Bounded table card** — `maxHeight: 60vh` + `overflow: auto` so the horizontal scrollbar sits at the bottom of the visible card, not at the bottom of all rows. Sticky `<thead>` keeps headers + filter row in view while scrolling.
4. **Brand edit modal** — Pencil "Edit" button in the BrandPanel header opens a modal to amend name, description, positioning, and competitive_summary. Saves via existing `brands.update`.
5. **Product dossier edit modal** — Pencil "Edit" button on each product card opens a tall modal with textareas for description, category, use_cases, competitors, differentiators, signals, research_summary. If the user changes signals, a new `products:reembed` IPC (calls `embedSignalsForProduct`) re-fingerprints them for the Live Monitor with no Perplexity cost.
6. **Brand-is-self hygiene fix.** New `src/main/lead-hygiene.ts` with `normalize()` (lowercases, strips punctuation + trailing legal suffixes), `isOwnBrandCompany()` (case/punct/suffix-tolerant substring compare against all brand names), and `buildOwnBrandsBlock()` (prompt section listing our brands with explicit "never select these as the customer" instruction). Injected into scanner Pass 1, Pass 2, and `monitor/qualify.ts` prompts. Post-filter applied in `insertCandidates` (scanner.ts) and before insert in `qualifyItem` (monitor/qualify.ts). Fixes the bug where e.g. Neptune Software was being identified as its own customer when an article mentioned them. Existing bad leads stay in the DB — user can delete or disqualify them (and Disqualify with a reason will feed the v1.3 learning loop too).

**v1.3.0 (2026-05-23):** Learning loop + rule scoping. Three architect-flagged items ship together:

1. **Learning loop, Layer A (prompt injection).** New `src/main/learning.ts`. `buildDisqualificationsBlock(productId)` pulls up to 8 most-recent disqualified opportunities for a product (reasoned ones first, unreasoned ones next) and renders them as `- "<headline>" — reason: <reason>` lines under a "Previously rejected" header. Injected into the prompts of `monitor/triage.ts`, `scanner.ts` Pass 1, and `monitor/qualify.ts`. The LLM mirrors the user's judgment within a day of feedback.

2. **Learning loop, Layer B (fingerprint penalty in pre-filter).** New `disqualify_vectors` table (per-product embeddings of past rejections). On `opps:disqualify`, the headline+signal_summary is embedded and stored fire-and-forget. In `bestProductMatch` (embed.ts), the raw signal-similarity score is multiplied by `(1 − penalty)` where the penalty kicks in only once a product has ≥3 disqualifications and only when the item is ≥0.70 similar to a past rejection. Constants: `DISQ_LEARNING_MIN_EXAMPLES = 3`, `DISQ_PENALTY_THRESHOLD = 0.70`, `DISQ_PENALTY_STRENGTH = 0.60`. The returned `ProductMatch` now also exposes `rawSimilarity` and `disqualifyPenalty` for logging.

3. **Global scan rules + custom-topic pinning.** New `scan_rules.scope` column (default `'product'`, also takes `'global'`). Both `buildGuardrails` (scanner.ts) and `buildProductGuardrails` (monitor/qualify.ts) now stitch global rules in front of product rules. New IPC `rules:listGlobal` / `rules:createGlobal`. Signal Config gets a new top "Global rules" card (collapsed). Custom-topic create form gets an optional "Apply rules from product…" dropdown; pinned product id lands in `signal_sources.config.pinnedProductId`. Scanner Pass 2 reads it and applies that product's rules + global rules. Custom-topic table now shows a "Pinned to" column with a brand chip.

**v1.2.0 (2026-05-23):** Spend & Health release. Four architect-flagged improvements ship together:

1. **Spend tracking.** New `api_calls` table logs every external LLM call (provider, model, stage, tokens, estimated USD). Pricing constants live in `src/main/pricing.ts` and are easy to update. Logging is fail-open via `src/main/spend.ts → recordApiCall()`. `completePerplexity` (`perplexity.ts`), `complete` (`llm.ts`), and the direct Anthropic call in `monitor/triage.ts` all take an optional `stage` + `relatedId` and log automatically. Every existing caller is tagged: `research` / `brand_summary` / `refresh_signals` / `manual_scan` / `triage` / `qualify` / `brief`. Settings has a new top "Spend" card (today / 7d / 30d totals + breakdown by stage). Live Monitor header has a "$X.XX today" badge.
2. **Refresh-signals.** `refreshProductSignals(id)` in `research.ts` re-derives just the buying-signal list using `sonar-pro` + a 1500-token schema (~10× cheaper than full deep research), then re-embeds. UI button appears on every researched product card.
3. **Source health.** `monitor:sources:health` IPC returns per-source 7d funnel counts (ingested / candidates / strong / opportunities) joined from `signal_items`. Live Monitor's Sources table now has four right-aligned numeric columns + a "low yield" badge when a feed has ≥20 ingested but 0 qualified in 7d. Added `idx_items_source` index.
4. **Disqualify reason.** New `opportunities.disqualify_reason` column. OpportunityDetail's Disqualify button now opens a native prompt for an optional one-liner; if set, it's shown in a red banner on the detail page. Stored for v1.3's learning loop. New `opps:disqualify(id, reason?)` IPC; the existing `opps:setStatus` is untouched (used by Qualify/Archive).

## 8. Conventions worth keeping

- **Synchronous SQLite.** `better-sqlite3` is sync; do *not* await its calls.
  IPC handlers wrap them in promises naturally because `ipcMain.handle`
  callbacks can return either values or promises.
- **All IPC has a typed mirror in `preload/index.ts`.** When you add a new
  `ipcMain.handle('foo:bar', …)`, also expose it on `window.lh.foo.bar`. The
  renderer reaches into IPC via that bridge only.
- **No `react-router`.** Page routing is two `useState` slots in `App.tsx`.
  Keep it that way — there are only ~8 pages and an overlay.
- **External links** must go through `window.lh.openExternal(url)` which
  calls `shell.openExternal`. Never use `<a target="_blank">` — Electron's
  CSP and `setWindowOpenHandler` both block it.
- **Use JSON schemas on Perplexity calls** (`jsonSchema` option in
  `completePerplexity()`) wherever the result needs to be parsed. The schema
  is enforced by Perplexity's `response_format: json_schema` and makes the
  output far more reliable than free-form prompting. Fall back to
  `tryParseJson` only for non-schema text returns.
- **Dedupe at the candidate level.** Perplexity returns opportunities with
  `source_url`s. The `seen_urls` table is consulted *after* Perplexity
  responds (we can't pre-filter what Perplexity will discover), and the URL
  is recorded before inserting the opportunity. Re-running a scan on the
  same topic will re-call Perplexity but won't double-insert opportunities.
- **Default to "open".** Newly qualified opportunities are always
  `status='open'` until the user explicitly Qualifies / Disqualifies /
  Archives. The Dashboard only shows `status='open'`.

---

## 9. User preferences and collaboration style

These came directly from the original request:

- **Owner does not code and does not want to learn.** Code everything. Do
  not hand the user pieces to assemble.
- **Minimize permission prompts.** Take autonomous action wherever it's
  safe. The only thing the user *had* to do manually was the one-time
  GitHub device-flow login (`gh auth login`), because that genuinely
  requires a human browser action.
- **Mac-native is non-negotiable.** Don't suggest cross-platform routes
  (web app, PWA) as alternatives — the explicit ask is a Mac app.
- **Match the provided screenshot.** The visual treatment in the
  screenshot is the spec. Specifically: dark sidebar, light content,
  purple primary CTA, status chip palette, four stat cards across the top
  of the Dashboard, "Open Opportunities" table beneath.
- **The product needs all four behaviors end-to-end:** knowledge ingestion,
  deep research, autonomous scanning, opportunity qualification with
  background / use case / angle / matched brand. Don't ship a partial
  shell.

---

## 10. Known limitations / good next steps

- **`signal_sources` is now optional.** Scans primarily use per-product
  auto-derived signals (from `products.signals`, written by deep research).
  The `signal_sources` table only feeds the secondary "Advanced — custom
  topics" pass. Nothing is auto-seeded into it anymore.
- **`signal_sources.kind` is informational.** New custom topics created in
  the UI use kind `'query'`. The old `google_news`/`rss` distinction no
  longer drives behavior.
- **`rss-parser` is dead code** since the scanner rewrite. Safe to remove
  from `package.json` if you're trimming deps.
- **DOCX/PPTX extraction is best-effort.** `yauzl` is loaded dynamically and
  is not in `package.json`, so today these files fall back to a placeholder.
  Add `yauzl` to dependencies to fully enable them.
- **No x64 build by default.** Intel Macs need the package.json change
  noted in §7.
- **No code signing / notarization.** First launch needs right-click → Open
  on every machine. Setting up an Apple Developer ID and adding
  `notarize: true` is a real-world ship blocker if distributing widely.
- **Brief dispatch is local-only.** `dispatch_log` records a brief, but
  there's no Slack/email/CRM integration yet. The schema is ready for it.
- **No background download of news bodies before LLM call.** The current
  `qualifyAndStore` fetches each URL synchronously inline. For high-volume
  scans, batching/parallelizing this would be the first optimization.

---

## 11. Live links

- **Repo:** https://github.com/reigntimelesssanctuary/LeadsHawk
- **v1.0.0 release + DMG:** https://github.com/reigntimelesssanctuary/LeadsHawk/releases/tag/v1.0.0
- **Local DMG (Apple Silicon):** `release/LeadsHawk-1.0.0-arm64.dmg`
- **Runtime data:** `~/Library/Application Support/LeadsHawk/data/leadshawk.db`
- **Runtime settings:** `~/Library/Application Support/LeadsHawk/settings.json`
