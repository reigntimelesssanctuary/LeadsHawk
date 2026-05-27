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
npm run smoke      # runs scripts/smoke-perplexity.mjs (~50ms, 23+ tests)
npm run dist:mac   # full build + electron-builder → release/LeadsHawk-<v>-arm64.dmg
npm run preship    # smoke → dist:mac (always run this before tagging/pushing)
```

The `dist:mac` target currently produces only arm64 (Apple Silicon). To also
produce x64, change `"arch": ["arm64"]` to `["arm64", "x64"]` in the
`build.mac.target` block of `package.json`. The build is **not** code-signed
(`identity: null`); first launch on macOS requires right-click → Open.

## 7b. Release discipline (IMPORTANT — read before shipping)

User is non-coder. The v1.7.x → v1.8.4 patch storm (8 patches in one
afternoon, with v1.7.2 / v1.7.3 / v1.8.4 each shipping broken because
they weren't smoke-tested or launched) created real friction. From
v1.8.5 onward, follow this discipline EVERY release without exception:

**Before every `git push` and `gh release create`:**

1. **Run `npm run smoke`.** It takes ~50ms. If any test fails, fix
   before pushing. The smoke test catches:
   - JSON parsing regressions (Perplexity reasoning-mixed output)
   - URL hygiene bugs (the v1.8.5 cleanUrl iterative-strip bug was
     caught here pre-push)
   - Brand-self filter false positives (Neptune Energy regression)
   - Empty-completion detection logic
2. **Run `npm run preship`** (which chains `smoke && dist:mac`). This
   gives you a DMG you can actually launch.
3. **Launch the packaged `.app`**, not just `npm run dev`:
   ```bash
   /Users/sanctuary/LeadsHawk/release/mac-arm64/LeadsHawk.app/Contents/MacOS/LeadsHawk
   ```
   Wait ~8 seconds. If it stays running, no startup crash. This catches
   class-of-bug-that-killed-v1.7.2 (Node-runtime / native-module
   incompatibilities that `npm run dev` doesn't surface because dev
   uses your system Node, not the packaged Electron Node).
4. **Only then `git push`, `git tag vX.Y.Z`, `git push origin <tag>`,
   and `gh release create`.**

**When adding any new pure-function logic** in `src/main/` (parsers,
hygiene filters, resolvers, etc.) — add a corresponding test case to
`scripts/smoke-perplexity.mjs` in the same commit. The smoke test
inlines copies of production functions because the real modules pull
in electron / undici / better-sqlite3 / settings.js which can't run
under bare Node. Header comment in the test file flags the manual-
sync requirement. Graduate to `vitest` with proper module mocking
once test count exceeds ~30 cases.

**When upgrading native dependencies** (better-sqlite3, undici,
@huggingface/transformers, electron itself) — always verify the
packaged `.app` launches, because a working `npm run dev` is no
guarantee against runtime incompatibility with Electron's bundled
Node. v1.7.2 shipped a broken undici@8 because it built fine in dev.

**When the user reports a scanner failure** — first check the v1.7.6+
diagnostic logs (head/tail preview, completion_tokens, citation
samples). They were added specifically to make these bugs diagnosable
from a log paste instead of guessing.

**Pre-push git hook (v1.8.6) enforces smoke automatically.** Activated
via `git config core.hooksPath scripts/git-hooks` — `npm install`
runs `scripts/setup-git-hooks.mjs` (the postinstall step) to set this.
The hook at `scripts/git-hooks/pre-push` runs `npm run smoke` and
refuses the push on failure with a clear error and a `--no-verify`
hint. To verify the hook is active in a fresh clone:
`git config core.hooksPath` should print `scripts/git-hooks`. If it's
missing or returns an error, re-run `node scripts/setup-git-hooks.mjs`.

**DO NOT use `git push --no-verify`** unless the smoke test failure
is a genuine known-good case (extremely rare). Bypassing the hook
defeats the purpose. If smoke fails for a "real" reason, fix the
test or the production code, don't skip.

---

## 7a. Which LLM does what

| Feature | API | Default model | Why |
|---|---|---|---|
| Product *Run research* | **Perplexity** | `sonar-deep-research` | Multi-step, live web search; cites sources |
| Autonomous scan jobs (manual / hourly) | **Perplexity** | `sonar-pro` | One call per researched product, anchored to that product's own auto-derived signals (no manual signal configuration required) |
| Deep scan — Stage 1 (discovery) | **Perplexity** | `sonar-deep-research` | v1.9: casts a wide net of named-company candidates with citations. Loose schema. No filtering. |
| Deep scan — Stage 2 (qualify) | **Anthropic Claude** | `claude-sonnet-4-6` | v1.9: applies ICP fit, scan rules, brand-self hygiene, pipeline dedupe, confidence. No web search. |
| Deep scan (single-stage fallback) | **Perplexity** | `sonar-deep-research` | v1.8.7 monolithic path. Still routed via `settings.deepScanTwoStage=false`. Kept as safety net through at least v1.9.x. |
| Brand competitive summary roll-up | **Perplexity** | `sonar-deep-research` | Shares context with research |
| Sales brief (*Generate brief*) | **Anthropic Claude** | `claude-opus-4-7` | Pure writing task, no research needed |

User asked (2026-05-20) to swap scans + research from Claude to Perplexity. Brief generation stayed on Claude because it wasn't part of that ask.

Later same day, user asked to make signals fully autonomous — the app derives signals from product research instead of requiring manual configuration. Scanner now iterates over researched products and uses each product's `signals` field as the search anchor for that product's scan pass.

**v1.1 (2026-05-23):** Live Monitor added — 24/7 ingestion → on-device embedding pre-filter → Claude Sonnet 4.6 triage → Perplexity deep qualify. See section 0.

**v1.1.1 (2026-05-23):** Dashboard bulk-select + Scan Type column; Live Monitor Fetched timestamps in SGT with AM/PM; per-product knowledge actions (Upload / Add Link / Add Note) on every product card. `research.ts` now prioritises product-scoped knowledge when researching that product.

**v1.1.2 (2026-05-23):** Custom app icon — gold circuit-pattern hawk on black. Source at `build/icon.png` (1254×1254), compiled to `build/icon.icns` and wired into `package.json > build.mac.icon` so electron-builder bakes it into the bundle and DMG. Sidebar version string bumped from v1.0.0 → v1.1.2.

**v1.1.3 (2026-05-23):** Sidebar now shows the LeadsHawk logo (256×256 PNG at `src/renderer/src/assets/logo.png`, rendered at 48×48 with 12px radius) above the "LeadsHawk" text. Dashboard "Open Opportunities" table now scrolls horizontally instead of clipping — table has `minWidth: 1080` and the wrapping `.card` uses `overflowX: 'auto'`.

**v1.13.5 (2026-05-27):** Delete individual past-feedback entries.

User feedback: feedback history shown in the re-research modals (signals, dossier, sources) was read-only — stale guidance kept getting re-injected into every future run, with no way to prune. Now every past entry has an inline `delete` link.

Hard delete (not soft) — feedback is a prompt hint, not historical truth. Past runs that already consumed the entry aren't retroactively un-applied (can't undo an LLM call), but future re-research runs stop seeing it.

Changes:

- **New `feedback:delete(id)` IPC** in `src/main/ipc.ts` — single `DELETE FROM dossier_feedback WHERE id = ?`.
- **Preload bridge** `window.lh.feedback.delete(id)`.
- **`FeedbackModal` history list** gains a per-entry `delete` action in the row header, paired with the `collapse`/`show full` toggle. Confirm-on-click. On success, the entry is optimistically removed from local state.
- **`ResearchSourcesModal` history list** gets the same treatment (history bumped from 5 → 8 visible entries while we were at it).

Covers all five feedback kinds via the shared modal logic: brand dossier, product dossier, brand signals, product signals, brand sources.

No schema changes. 81 smoke tests still pass.

**v1.13.4 (2026-05-27):** Delete button on expired trials + remove 15-source soft cap.

Two quick UX improvements following v1.13.3 trial-mode usage:

1. **Delete button alongside Keep / Extend on expired trials.** The trash icon at the row end has always worked, but having the full triage decision (`Extend` / `Keep` / `Delete`) inline in the Trial column matches how users actually think about expired sources. Active trials still show only Keep (delete remains accessible via the trash icon at row end).

2. **Removed the 8–15 soft cap on source suggestions.** The `SOURCE_RESEARCH_SYSTEM` prompt in `src/main/source-research.ts` said *"Aim for 8–15 suggestions total"* — Perplexity was honouring that as an upper bound. Rewritten to mirror the v1.9.1 signal-count widening pattern: *"List as many sources as are GENUINELY useful for this brand — minimum 5, no upper cap. Quality over quantity: a few sharp, signal-aligned sources beat dozens of generic ones."* The practical ceiling is now the `maxTokens: 6000` budget (~30–50 suggestions possible if the model has the relevance to fill them).

No schema changes. 81 smoke tests still pass.

**v1.13.3 (2026-05-27):** Swap Live Monitor section order — Sources above Recent items.

User UX feedback: configuration (Sources) should appear above the resulting stream (Recent items). New order on the Live Monitor tab:

1. Page header + funnel cards (unchanged)
2. v1.12.1 diagnostic banner (when applicable)
3. Manual intake card
4. **Sources card** (was below)
5. **Recent items card** (was above)
6. Modals

Pure JSX swap in `src/renderer/src/pages/LiveMonitor.tsx`. No backend or schema changes. 81 smoke tests still pass.

**v1.13.2 (2026-05-27):** Persist pending source-research suggestions so closing the modal mid-research doesn't waste the Perplexity spend.

User noticed that during the 1-3 minute Perplexity call in `ResearchSourcesModal`, closing the modal would silently discard the result — the IPC call kept running in the main process and the spend was logged, but the returned suggestions had nowhere to land (React component unmounted). Net effect: $0.05-0.30 wasted per closed-mid-research.

**Fix architecture:**

- **New `pending_source_suggestions` table** (idempotent migration): `(id, brand_id UNIQUE, suggestions_json, created_at, consumed_at)`. One row per brand at most — UPSERT on `brand_id` so a new research run replaces the previous pending result.
- **`researchBrandSources` writes its sanitised result** to the table right before returning. Runs regardless of whether the renderer is still listening.
- **New IPCs**:
  - `brands:pendingSources(brandId)` — returns `{ suggestions, created_at } | null`. Used by the modal's `useEffect` on open to auto-resume.
  - `brands:pendingSourcesSummary()` — returns `Array<{ brandId, count, createdAt }>` for the Live Monitor banner.
  - `brands:dismissPendingSources(brandId)` — marks `consumed_at = now`, suppresses the banner.
- **Modal auto-resume**: when the modal opens, it checks for pending suggestions first. If present, jumps straight to the review phase with those suggestions pre-loaded — no new Perplexity call needed.
- **Auto-consume on Add**: `addSuggestedSources` also stamps `consumed_at` after a successful insert/merge, so the banner clears.
- **72h freshness window**: pending suggestions older than 72h are treated as stale and not returned by either IPC.
- **Live Monitor banner**: above the Sources card, a purple banner lists brands with pending suggestions and offers `Review →` (opens the modal — which then auto-loads them) + `Dismiss` per brand.

**Modal UX text updates:**
- idle phase copy: *"Closing the modal mid-research is safe — suggestions are saved and re-loaded next time you open this modal."*
- researching phase footer: *"You can safely close this window — suggestions are saved and will appear when you open Research sources again for [Brand]."*

No smoke-test additions (the new logic is SQL + UPSERT, not pure-function). 81 tests still pass.

**v1.13.1 (2026-05-27):** Trial mode + brand-grouped sources + Research-sources button moved to Live Monitor.

User feedback on v1.13.0: wanted (a) a trial period for newly-discovered sources, (b) Live Monitor's Sources card grouped by brand instead of one flat list, (c) the Research-sources button on the Live Monitor tab where sources live.

**Trial mode:**
- New `monitor_sources.trial_until TEXT NULL` column (idempotent migration). When set, the monitor's poll cycle auto-disables the source after the timestamp passes.
- New monitor-loop sweep `sweepExpiredTrials()` runs every 60s alongside the poll cycle. Single UPDATE statement; logs how many were disabled.
- `ResearchSourcesModal` gets a trial-period selector before the Add button: 24h / 48h / 7d / Permanent. Default `24h` — safest cost trajectory for unvalidated suggestions.
- New IPCs: `monitor:sources:promoteTrial(id)` (clears `trial_until`, makes permanent) and `monitor:sources:extendTrial(id, days)` (pushes `trial_until` forward).
- Pure helper `computeTrialUntil(period, now?)` in `src/main/source-research.ts` — exported for smoke testing.

**`brands:addSuggestedSources` rewrite:**
- Detects URL collisions: if the same URL already exists in `monitor_sources`, the new brandId is merged into `config.serves_brand_ids` instead of inserting a duplicate. This is what creates "Common sources" (sources serving ≥2 brands).
- Accepts new `opts.trialPeriod` argument; new rows get `trial_until` set via `computeTrialUntil()`.
- Return shape changed: `{ added: number[], merged: number[], trialUntil }` (was bare `number[]`). Modal renders both counts in the success screen.

**Live Monitor Sources card redesign (`groupSourcesByBrand` pure helper):**
- Three groups rendered as collapsible sections:
  - **Per-brand sections** — one per brand, only sources with `serves_brand_ids` containing exactly that brand. Each section has a `Discover more` button that opens the modal scoped to that brand.
  - **Common sources** — sources with ≥2 brand IDs in `serves_brand_ids`. Includes a new "Serves" column with brand-name pills.
  - **Unassigned** — sources with no `serves_brand_ids` (default seeded + manually added). Shown at the bottom.
- New per-row "Trial" column shows time-remaining chip + Promote (`Keep`) / Extend buttons. Expired trials show red chip + Extend (7d) + Keep buttons.
- Orphaned brand IDs (referenced brand was deleted) fall into the Common section gracefully.

**Research-sources button moved:**
- Removed from the brand panel in Brands & Products.
- Added to Live Monitor → Sources card header. Click opens a brand-picker dropdown listing brands with `research_status === 'ready'`. Selecting a brand opens the same `ResearchSourcesModal`.
- Each per-brand section's "Discover more" link bypasses the picker for that brand.

**Type additions** in `src/shared/types.ts`:
- `MonitorSource.trial_until: string | null`
- New `MonitorSourceConfig` typed shape for the JSON config field
- `SourceGrouping` return type from `groupSourcesByBrand`

Smoke tests 75 → 82. 7 new tests cover `computeTrialUntil` (permanent → null, 24h/48h/7d arithmetic) and `groupSourcesByBrand` (splits buckets correctly, handles orphaned brand IDs).

**v1.13.0 (2026-05-27):** Auto-research news sources per brand.

User insight after v1.12.1's diagnostics surfaced that default RSS sources were misaligned with workspace-design (Zyeta) and banking-software (Neptune) brands: *"Similar to signal config, LeadsHawk will do research and determine what signals to chase. What if we get LeadsHawk to determine what sources to follow for each brand?"*

Mirrors the v1.9.2 signal-research decoupling pattern. Brand dossiers already know who the brand sells to + what signals matter — LeadsHawk now uses that context to suggest RSS feeds + Google News queries that should surface relevant news.

**New backend** (`src/main/source-research.ts`):
- `researchBrandSources(brandId, { feedback? })` — Perplexity `sonar-deep-research` with brand dossier as context, JSON-schema output (sonar-deep-research handles json_schema reliably, per v1.10.x experience).
- Returns `SourceSuggestion[]` shaped `{ kind: 'rss' | 'google_news', name, url|query, why_relevant }`. **Does NOT persist** — user reviews + selects.
- `buildGoogleNewsRssUrl(query)` — pure helper that constructs the Google News RSS URL from a search query. Exported for smoke testing.
- Sanitisation step trims/caps fields and drops malformed suggestions before returning.

**New IPC**:
- `brands:researchSources(id, { feedback? })` → returns suggestions
- `brands:addSuggestedSources(brandId, suggestions[])` → bulk-inserts selected suggestions into `monitor_sources`. RSS sources use the suggested URL directly; Google News sources construct via `buildGoogleNewsRssUrl()`. Each row's `config` JSON gets `suggested_by_brand_id` + `suggested_at` for traceability.

**New UI**:
- `src/renderer/src/components/ResearchSourcesModal.tsx` — multi-phase modal:
  - **idle** — optional feedback textarea (with past feedback history shown above) + "Research sources" button
  - **researching** — spinner + "Takes 1–3 minutes" caption
  - **review** — checkable list of suggestions with kind chip (RSS/Google News), URL or query preview (RSS URL clickable to open externally), why-relevant explanation, select-all/clear helpers
  - **adding** — spinner during bulk-add
  - **done** — success count + auto-close
- `BrandsProducts → BrandPanel` — new **"Research sources"** button next to "Re-research with feedback" on the brand header. Opens the modal scoped to that brand.

**Feedback integration** (extends v1.9.2 infra):
- `FeedbackTargetKind` extended to include `'brand_sources'` (in both `src/shared/types.ts` and `src/main/feedback.ts`)
- Past feedback re-applies on subsequent runs so corrections persist across iterations, same pattern as signal and dossier research.

**Cost Management integration**:
- New `LlmStage` tag `'brand_source_research'` in `pricing.ts`
- New `OperationType` bucket `'source_research'` in `spend.ts` mapped from the new stage
- New row label in Cost Management's stage drill-down + a new operation row when calls exist
- Cost per call: ~$0.05-0.15 (sonar-deep-research, modest token budget)

**Source addition flow** integrates cleanly with the existing `monitor_sources` table — once added, sources poll on their normal schedule and feed the Live Monitor pipeline. No new schema columns.

Smoke tests 71 → 75: `buildGoogleNewsRssUrl` parsing (encodes plain queries, encodes Boolean operators, handles empty/whitespace) + `operationForStage('brand_source_research') → 'source_research'`.

**v1.12.1 (2026-05-27):** Live Monitor diagnostic UI + threshold default lowered.

User reported Live Monitor was ingesting items but producing zero candidates (and therefore zero opportunities). Diagnostic data: ~283 items ingested over 7 days, 0 candidates. The embedding pre-filter was dropping everything silently.

Three causes contribute to this pattern; v1.12.1 makes them visible:

1. **Per-product embedding status indicator in Signal Config.** New `products:embeddingStatus` IPC returns `Record<productId, embeddingCount>`. `SignalConfig.tsx` fetches it and renders next to each product:
   - `✓ embedded (N)` green chip when vectors are populated
   - `⚠ needs embedding` amber chip + inline `Embed now` button (calls existing `products:reembed`) when signals exist but embeddings are null. Catches the silent-fire-and-forget failure mode of `embedSignalsForProduct()`.

2. **Diagnostic banner on Live Monitor.** Fires when last-24h `ingested > 0 && candidates === 0` OR when 7-day aggregate shows ≥20 ingested with 0 across all sources. Lists the three usual causes with inline fix actions:
   - Threshold too strict → one-click "Lower to 0.40" button (writes via `settings:update`)
   - Embeddings missing → links to Signal Config (via `onNavigate` prop, same pattern as BrandsProducts)
   - Source-portfolio misalignment → text only (auto-discovery coming in v1.13)
   - Dismissible per-session.

3. **Settings threshold helper text.** Updated under the embedSimilarityThreshold input to recommend 0.40 and explain when to lower.

4. **Default `embedSimilarityThreshold` lowered 0.55 → 0.40** for NEW installs only. Existing user settings preserved by electron-store (no migration). Rationale: 0.55 was too strict in practice — real product-signal vs news-headline matches consistently sit at 0.40-0.50. Sonnet triage downstream is the cheap filter for false positives; the embedding pre-filter should cast a wider net.

LiveMonitor.tsx gains an `onNavigate?: (p: Page) => void` prop (same pattern v1.9.2 added to BrandsProducts) so the diagnostic banner's "Open Signal Config →" action can switch the active page directly.

No schema changes. 71 smoke tests still pass.

**v1.12.0 (2026-05-27):** Manual scan retired. Deep scan is now "the scan".

User feedback: deep scan produces materially better leads than manual scan in v1.10.x, and maintaining two scan pipelines doubles bug surface. Quality is the priority. Architectural cleanup follows.

**What's removed:**
- `scan:run` IPC handler (manual scan trigger). `runScan()` stays available as the single-stage fallback `runDeepScan()` routes to when `deepScanTwoStage=false`, but no user-facing trigger calls it anymore.
- `window.lh.scan.run` from the preload bridge.
- The manual-scan cron registration in `scheduler.ts`. Scheduler now only handles deep scan.
- The "Schedule" card on the Scan Jobs page (manual cron editor). Deep scan's schedule lives in Settings → Scan card.
- The "Run Scan Now" button on Scan Jobs (the cheap one); the remaining button (renamed from "Run Deep Scan Now") triggers deep scan.

**What's renamed:**
- Settings card "Deep Research Scan" → **"Scan"**. Copy updated to reflect that the two-stage deep scan is now the only autonomous scan engine.
- Scan Jobs history table — `manual` kind chip relabeled to `manual (legacy)` (any historical manual-scan rows in `scan_runs` still render with their original kind); deep scan rows render as `scan`.
- Dashboard's "Run Scan Now" button kept in place but rewired to `runDeep`. Same label, same prominence.

**What's deprecated:**
- **Custom topics** (`signal_sources` rows, the "Advanced — custom topics" section in Signal Config). Custom topics ran only via the v1.7.5 manual-scan Pass 2 codepath, so they're orphaned by this change. The section now shows a yellow deprecation banner explaining they're preserved in the DB but no longer execute. Users can delete topics they no longer need or leave them as a record.

**What stays:**
- `settings.scanCron` / `scanEnabled` fields kept in the `Settings` type for back-compat reads (no migration needed). Unused at runtime.
- `runScan()` in `scanner.ts` — still the single-stage fallback path under `runDeepScan()` when `deepScanTwoStage=false`.
- `signal_sources` table — data preserved.

No schema changes. 71 smoke tests still pass.

**v1.11.1 (2026-05-27):** Per-scan-instance cost breakdown + Settings Spend card removed.

User feedback after using v1.11.0: the Cost Management tab showed aggregated totals but not per-individual-scan cost. Also flagged that with the Cost Management tab live, the Spend card in Settings was redundant.

**Per-scan-instance cost.** New `getRecentScanRunCosts(limit)` in `spend.ts` joins the `scan_runs` table to `api_calls` by time window (filtered to scan-related stages: `manual_scan`, `deep_scan`, `deep_scan_discovery`, `deep_scan_qualify`). Returns the most recent N runs from the last 30 days as `ScanRunCostRow[]` with: `run_id`, `kind`, `started_at`, `finished_at`, `status`, `items_scanned`, `opportunities_created`, `cost`, `api_calls`. Live Monitor and research api_calls that fire during a scan window are excluded by the stage filter, so attribution is accurate even when other operations run in parallel.

Added to `CostSummary.recentScanRuns`. New "Recent scan runs — cost per instance" section in `CostManagement.tsx` between the operation table and the by-provider section. Columns: Started, Kind, Status, Items scanned, Opps, API calls, Cost, Cost/opp. Totals row at the bottom. Status + kind shown as chips.

**Settings Spend card removed.** The Spend card with stage breakdown that was in Settings is gone — same data + more lives in the Cost Management tab now. Stripped: `SpendSummary` import + `spend` state + 30s polling effect + the Spend card block + the local `STAGE_LABELS` map + the local `SpendStat` helper component. Settings header sub-text updated to point users at the Cost Management tab. `getSpendSummary()` and the `spend:summary` IPC are kept (no other consumers, but harmless leftover for now — can prune in a future cleanup).

No schema changes. No smoke-test additions (the new function is SQL, not pure logic). 71 smoke tests still pass.

**v1.11.0 (2026-05-27):** New **Cost Management** tab in the sidebar.

User asked for "a summary of how much API costing each type of scan incurs". The existing Settings → Spend card showed totals + by-stage and by-model breakdowns, but stages are too granular to read quickly — "brand_research_verify" + "brand_research_strategic" + "brand_research_factcheck" all relate to brand-research work but appear as separate rows. v1.11.0 aggregates them into user-facing operation buckets and gives the breakdown its own dedicated tab.

**Operation buckets** (defined in `src/main/spend.ts → operationForStage`):
- `brand_research` ← `brand_research`, `brand_research_verify`, `brand_research_strategic`, `brand_research_factcheck`, `brand_summary` (legacy)
- `product_research` ← `research`, `product_research_verify`, `product_research_strategic`, `product_research_factcheck`
- `signal_research` ← `brand_signals`, `product_signals`, `refresh_signals` (legacy)
- `manual_scan`, `deep_scan` (covers v1.8.x single-stage + v1.9.0 two-stage), `live_monitor` (triage + qualify), `sales_brief`, `other` (catch-all)

**Backend**: new `getCostSummary()` in `spend.ts` returns four time windows (today, last 7d, last 30d, all time) each with `byOperation` breakdown, plus 30-day `byModel`, `byStage`, `byProvider` arrays. Exposed via new IPC `cost:summary` → `window.lh.cost.summary()`.

**UI** (`src/renderer/src/pages/CostManagement.tsx`):
- Period totals card with four stat boxes
- "Cost by operation type" table showing all 8 buckets × 4 time windows side-by-side + totals row
- "By provider (last 30d)" — useful for matching against Anthropic / Perplexity billing dashboards
- "By model (last 30d)"
- "By stage (last 30d)" — finest-grained drill-down with the human labels from Settings
- Auto-refreshes every 30 seconds, plus a manual "Refresh now" button

**Sidebar entry**: new "Cost Management" item with `DollarSign` icon, between Archive and Settings. New `Page` type member `'cost'`.

Budget tracking (user-set monthly cap + burn-rate projection) was explicitly scoped out — user opted for the leaner "just cost breakdown" option. Existing Settings → Spend card is kept as the at-a-glance summary.

Smoke tests 61 → 71. 10 new tests cover `operationForStage` (every stage maps correctly + unknown falls through to `other`) and `bucketByOperation` (sums calls + cost per operation, drops empty buckets, preserves canonical order).

**v1.10.3 (2026-05-27):** Two UX patches the user surfaced after running v1.10.2 on their portfolio.

**Fix 1 — Cisco products not visible in Signal Config (v1.9.2 oversight).**
`SignalConfig.tsx` filtered the product list by `research_status === 'ready' && p.signals`. Since v1.9.2 decoupled signal research from dossier research, a freshly-researched product has `signals=NULL` until Signal Config's *Research signals* button is clicked — but that button was hidden because the product got filtered out before render. Dropped the `&& p.signals` clause so the filter matches what the brand-level section already does (show all researched targets, let the button take care of empty signals). Updated the "products not researched" muted-text message to be accurate about needing *dossier* research first.

**Fix 2 — Stage 4 status chip turning amber on 9/10 source coverage.**
v1.10.2's `ResearchStatusChip` treated *any* Stage 4 `partial` status as amber, even when 90% of sources verified successfully. New `stage4SourceCoverage` helper extracts the K/N ratio from `"partial: K/N sources verified …"` and applies tiered thresholds:
- ≥80% verified → **green ✓** (with `(N% sources)` mini-note)
- 50–79% verified → **amber ⚠**
- <50% verified, or any hard failure → **red ✗**

So Cisco's 9/10 outcome now reads green-with-note instead of being a misleading warning, while a 4/10 outcome still flags amber and a 1/10 outcome still flags red.

Smoke tests 56 → 61. 5 new tests cover `stage4SourceCoverage` parsing (K/N regex match, edge cases — non-partial status, no ratio present, undefined input).

**v1.10.2 (2026-05-27):** Stage 4 fact-check (fetch cited URLs + Opus verifies dossier claims against actual source text). Final piece of the original v1.10 vision.

Stages 2+3 give Opus a verified-against-knowledge dossier, but Opus had no way to fact-check Stage 1's claims against the original web sources Perplexity cited. Stage 4 closes that loop.

Architecture (only `researchBrand` and `researchProduct` change; everything downstream unchanged):

- **New `src/main/research/dossier-factcheck.ts`** — `factCheckDossier({ targetKind, targetId, targetName, verifiedDossier, citationUrls, maxSources })`. Steps:
  1. Dedupe + cap citation URLs to `factCheckMaxSources` (1-15, default 10).
  2. Fetch all sources in parallel via existing `fetchUrl()` helper. Per-source 15s timeout. Failed fetches (paywall, JS-rendered, blocked) are skipped, not fatal — bundled into the success/partial bookkeeping.
  3. Cap each fetched source text at 8000 chars to bound token cost.
  4. If <2 sources usable → skip Opus call with `partial: only K/N sources reachable` status (no point spending Opus tokens on too-thin sample).
  5. Otherwise send Opus the verified dossier + fetched sources, ask for per-section verdicts (verified / partially_supported / unsupported / inconclusive) + flagged claims list.
- **Return shape**: discriminated union — `completed` | `partial` (with warning) | `skipped` (reason) | `failed` (error). All surfaced to `research_status_detail.stage4` for the UI chip.
- **New `brand_research_factcheck` / `product_research_factcheck` LlmStage tags** for spend tracking.

**Schema additions** (idempotent) on `brands` AND `products`:
- `fact_check_report TEXT` — JSON output (overall_confidence, sources_attempted, sources_fetched, per_section_verdicts, flagged_claims)
- `last_fact_check_at TEXT` — timestamp of last successful Stage 4

`ResearchStatusDetail.stage4` optional field tracks the same status pattern (`completed | partial: ... | skipped: ... | failed: ...`).

**Settings — Research depth card extended** with three new controls (all default ON):
- `brandResearchFactCheck` toggle
- `productResearchFactCheck` toggle
- `factCheckMaxSources` number input (1-15, default 10)

**UI** in `BrandResearchPanel` and product card dossier render:
- New "Fact-check report (Stage 4 — Claude Opus)" collapsible section below "Strategic Intelligence". Shows overall confidence pill, sources-fetched stat (`8/10 sources verified`), per-section verdict cards (with verdict pill + reasoning + supporting source links), flagged claims rows (status badge + claim text + reason + source link).
- `ResearchStatusChip` extends to include Stage 4 — green when all four stages ✓, amber when Stage 4 partial (some sources unreachable), red when any failure.
- Dossier expand summary tag becomes `Opus verified + fact-checked` when both `last_advanced_research_at` and `last_fact_check_at` are set.

**Stage 1 citations now actually captured**. v1.10.0 had `JSON.stringify({ stage1: json, citations: [] })` — Perplexity's citations were thrown away. Fixed in v1.10.2: `const { json, citations } = await completePerplexity(...)`, citations flow into both `raw_dossier` and Stage 2's input, and feed Stage 4's URL fetch list.

**Cost** — per research run jumps from \$0.55-1.10 (Stages 1-3) to \$1.85-2.90 (with Stage 4). For 10 brands + 30 products refreshed monthly with all 4 stages on: ~\$60-80/month.

**Smoke tests 50 → 56.** 6 new tests cover `clampCitationList` (dedup, cap, whitespace, null), `shouldAttemptOpusCall` (min-2-sources gate), and `extractCitationsFromRawDossier` (parses v1.10.0+ raw_dossier shape, graceful on malformed).

**v1.10.1 (2026-05-27):** Patch for Opus temperature deprecation + per-stage status surfacing + dossier signal cleanup.

User installed v1.10.0, ran brand re-research on Zyeta, dossier text refreshed but none of the new Opus features appeared. Terminal log showed `400 invalid_request_error: "temperature is deprecated for this model"` from `claude-opus-4-7`. Anthropic deprecated the `temperature` parameter for Opus 4.7+; my v1.10.0 code was passing `temperature: 0.2` / `0.3` and getting 400'd. Stage 2 caught the error and returned null → Stage 3 skipped → no Opus features rendered. v1.10.0 had no visible indicator of the failure — the silent-failure pattern.

Three fixes:

1. **`modelSupportsTemperature` predicate in `llm.ts`** — exported pure function gated by a regex allowlist `[/^claude-opus-4-7/i]`. Both `complete()` in `llm.ts` and the direct Anthropic call in `monitor/triage.ts` now conditionally include `temperature` only when the predicate returns true. Future deprecations: add to the allowlist.
2. **`dossier-verify.ts` + `dossier-strategic.ts` return discriminated unions** — `StageResult<T> = { ok: true; output: T } | { ok: false; error: string }`. Error reasons now flow from Opus API → caller → DB → UI instead of being lost in a null return value.
3. **`research_status_detail` column on `brands` and `products`** (idempotent migration) — JSON-serialised per-stage outcomes (`stage1`, `stage2`, `stage3`, `last_attempt_at`). Populated at the end of every research run regardless of success/failure. Captures: `completed`, `skipped: <reason>` (toggle off or no API key), or `failed: <reason>` (the actual error string from `StageResult.error`).
4. **`ResearchStatusChip` component** rendered on the brand panel and per-product card. Three colour states: green (all three stages OK), amber (Stage 2 skipped — toggle off or no key), red (any failure). Click expands to show the full per-stage status object. Always visible — no need to expand the dossier to see what happened.
5. **Signal fields removed from dossier panels** — the v1.9.2 cleanup oversight you flagged. Brand-level signals and product-level signals are managed only in Signal Config now. `BrandResearchPanel` and the product dossier render no longer show the signal Field.

Smoke tests grew 46 → 50. Four new tests cover `modelSupportsTemperature` (Opus 4.7 deprecated; Sonnet 4.6 / Haiku 4.5 still supported; unknown future model defaults-allow).

**v1.10.0 (2026-05-27):** Opus dossier verification + strategic intelligence.

Brand and product research are LeadsHawk's foundational asset — everything downstream is bottlenecked by dossier quality. v1.10.0 chains Claude Opus after the Perplexity Stage 1 research to:

1. **Verify and sharpen** — strip generic marketing language, annotate per-field confidence (high/medium/low), produce a "What we don't know" markdown subsection.
2. **Add a strategic intelligence layer** — 3-5 ICP segments (name, description, decision-maker, cycle length, key signals), a buying-cycle scenarios narrative, a competitive plays narrative.

Architecture (only `researchBrand` and `researchProduct` change; signal-research / scanner / live monitor / deep scan all untouched):

- **Stage 1 — Perplexity sonar-deep-research** (unchanged from v1.9.x). Now writes to a new `raw_dossier` audit column so Stage 2 can overwrite the canonical fields without losing the raw text.
- **Stage 2 — Claude Opus verify** (`src/main/research/dossier-verify.ts`). `claude-opus-4-7`, 6k tokens, NO web search — works only with Stage 1's output + the user's knowledge blob + reviewer feedback. Returns sharpened field values, per-field confidence levels, and an unknowns list. Persists into `verified_dossier`, `confidence_levels`, `unknowns` columns and overwrites canonical `category` / `positioning` / `target_icp` / etc. with sharpened versions. New `'brand_research_verify'` / `'product_research_verify'` LlmStage tags.
- **Stage 3 — Claude Opus strategic intel** (`src/main/research/dossier-strategic.ts`). Same model, 6k tokens, no web search. Input is Stage 2's verified dossier; output is `{ icp_segments[], buying_cycle_scenarios, competitive_plays }` persisted to `strategic_intel`. New `'brand_research_strategic'` / `'product_research_strategic'` LlmStage tags.
- **Failure handling**: Stage 2 failure preserves Stage 1's output and skips Stage 3. Stage 3 failure preserves Stage 2's output. Partial success is always better than rollback. Anthropic key not configured → skip Stages 2+3 with a logged warning.

**Feedback wiring extended.** The v1.9.2 `dossier_feedback` table's `target_kind` already supported `'brand'` and `'product'` for forward-compat. v1.10.0 wires them up: `brands:research(id, { feedback? })` and `products:research(id, { feedback? })` accept feedback that's injected into ALL three stages' prompts. The shared `FeedbackModal` (renamed from `SignalFeedbackModal`, generalised to all four kinds) now drives "Re-research with feedback" buttons on the brand panel and per-product card too. Past feedback re-applies automatically on subsequent runs.

**Schema additions on both `brands` and `products`** (idempotent migrations):
- `raw_dossier TEXT` — Stage 1 audit when Stage 2 overwrites canonical fields
- `verified_dossier TEXT` — Stage 2 JSON output (full audit)
- `confidence_levels TEXT` — JSON `{ field_name → 'high'|'medium'|'low' }`
- `unknowns TEXT` — Stage 2 "What we don't know" markdown
- `strategic_intel TEXT` — Stage 3 JSON (`icp_segments[]`, `buying_cycle_scenarios`, `competitive_plays`)
- `last_advanced_research_at TEXT` — timestamp; null until Stages 2+3 successfully ran

**Settings** — new "Research depth" card with two toggles, both default `true`:
- `brandResearchAdvanced` — enable Opus chain on brand research
- `productResearchAdvanced` — enable on product research
Uncheck either to fall back to v1.9.x's Stage-1-only behaviour. Settings → Spend shows the four new stages as separate rows.

**UI (option a — inline)** on `BrandResearchPanel` and per-product dossier:
- Confidence pills (green=high, amber=med, red=low) next to each field when `confidence_levels` is populated
- "What we don't know" subsection in an amber callout when `unknowns` is non-empty
- "Strategic Intelligence (Claude Opus)" collapsible section rendering `icp_segments` as a grid of cards + the two markdown narratives
- "Opus verified" mini-tag next to the dossier expand summary when `last_advanced_research_at` is set
- `Re-research with feedback` button next to existing `Re-research` button on brand panel and per-product card

**Cost**: per-call jumps from ~$0.10-0.30 (Stage 1 only) to ~$0.55-1.10 (Stages 1+2+3). For 10 brands + 30 products refreshed monthly: ~$25/month. Negligible at portfolio scale.

**What stays the same**: scanner (manual + deep scan), live monitor, signal research, cross-match, URL hygiene, brand-self filter, confidence threshold, scan rules, recency, smoke tests (46 still pass — no new pure-function logic; the new modules are prompt orchestration which doesn't fit the inline-copy smoke pattern).

**v1.9.4 (2026-05-27):** Drop `response_format: json_schema` for signal research entirely.

v1.9.3's shape-tolerant parsing + retry didn't fix the bug. Failures came back with *"twice in a row"* in the error message — meaning both attempts produced responses that neither `extractSignalsField` nor `extractBulletsFromText` could parse. Diagnosis: `sonar-pro` + sync `/chat/completions` + `response_format: json_schema` mode appears to return empty or near-empty content payloads for this prompt shape. (Why it works for `sonar-deep-research` via the async endpoint, but not for sonar-pro via sync: unknown — likely a Perplexity-side schema-enforcement quirk.)

Fix in `src/main/signal-research.ts`:

- **Drop `jsonSchema` from both `callWithRetry` invocations.** No `response_format` header sent.
- **SYSTEM prompt rewritten** to ask explicitly for a markdown bulleted list with no preamble/commentary.
- **Per-call prompt** ends with explicit `Output format:` instructions repeating the bullets-only requirement, plus inline quality-guidance examples (since the schema description that previously carried this no longer reaches the model).
- **Extractor order reversed.** `extractBulletsFromText` is the primary path now; the JSON-field extractor runs as a fallback in case the model wraps its output anyway. Both helpers + retry + diagnostic logging from v1.9.3 are unchanged.

Signals are inherently a markdown bullet list — the JSON wrapper was always overhead, and apparently unreliable overhead at that. This is the cleaner architecture.

Smoke tests unchanged at 46 (the extractor helpers and their tests didn't change). Manual launch + verification deferred to user.

**v1.9.3 (2026-05-27):** Signal-research parsing hardened. v1.9.2's `researchBrandSignals` and `researchProductSignals` consistently failed against `sonar-pro` with *"Perplexity returned an unparseable signals response. Try again."* — the new prescriptive SYSTEM prompt (with GOOD/BAD signal examples) was making the model emit bullets as raw text instead of in the JSON wrapper.

Five defensive fixes in `src/main/signal-research.ts`:

1. **Simplified SYSTEM prompt** back to the v1.8.x form (`"You are a senior B2B competitive-intelligence analyst. You produce sharp, concrete buying-signal lists."`) plus a one-sentence reminder to return strict JSON. Quality guidance now lives only in the schema field description.
2. **`extractSignalsField`** — shape-tolerant: accepts `signals`, `signal`, `bullets`, `signal_list`, `signals_list`, `buying_signals` keys, AND coerces array values to bulleted strings.
3. **`extractBulletsFromText`** — fallback that pulls markdown bullets out of raw response text when JSON parsing fails entirely. Normalizes `•` and `*` markers to `-`.
4. **One retry on parse failure** — pause 2s, try again. Diagnostic head/tail preview logged to main-process console on each failed attempt so future failures are inspectable.
5. **maxTokens bumped 1500 → 2500** — brand-level signal lists were tight against the old ceiling.

Smoke tests grew 37 → 46. 9 new tests cover `extractSignalsField` (canonical, array coercion, key variants, empty/null edge cases) and `extractBulletsFromText` (markdown extraction, bullet-marker normalization, no-bullets returns null).

**v1.9.2 (2026-05-27):** Signal research decoupled into its own job.

Previously, `brands.signals` and `products.signals` were side-effects of dossier research — every time you re-ran research on a product, the entire dossier (including signals) was regenerated, even if all you wanted was a fresh signal list. Conversely, there was no way to iterate on signals with reviewer feedback without paying for full re-research.

v1.9.2 separates these concerns:

- **`signals` field is removed** from `RESEARCH_SCHEMA` and `BRAND_RESEARCH_SCHEMA`. Dossier re-research no longer writes to the signals column; existing stored signals are preserved untouched.
- **New module** `src/main/signal-research.ts` exposes `researchProductSignals(id, {feedback?})` (mirrors+replaces the old `refreshProductSignals`) and `researchBrandSignals(id, {feedback?})` (new). Both are Perplexity sonar-pro calls, cheap (~$0.005–0.02), and the product variant re-embeds signals afterwards for the Live Monitor pre-filter.
- **New IPC** `brands:researchSignals` + `products:researchSignals` (the old `products:refreshSignals` is removed — no back-compat alias since we control the only UI).
- **New `LlmStage` tags** `brand_signals` and `product_signals`. The legacy `refresh_signals` tag stays in the enum so historical spend rows still label correctly.

**Reviewer feedback infrastructure (introduced here, reused by v1.10.0).**
New table `dossier_feedback(target_kind, target_id, feedback, applied_at, created_at)`. New module `src/main/feedback.ts` with `listFeedback`, `addFeedback` (4000-char-per-submission cap, validated server-side), `markFeedbackApplied`, and `buildFeedbackBlock` (newest-first, total cap 16000 chars — older entries drop entirely rather than partial-truncate so the model never sees a half-feedback). `target_kind` accepts `'brand'`, `'product'`, `'brand_signals'`, `'product_signals'` — v1.9.2 uses only the two `_signals` variants; v1.10.0 will extend to dossier feedback.

**Signal Config UI rebuilt.** New top sections:
- **Brand-level signals** — one row per researched brand with a `Research signals` button and a `Re-research with feedback` button. Signal preview shown inline below the action row.
- **Product-level signals** — existing per-product expandable card gets `Research signals` + `Re-research with feedback` buttons on the action row. Scan-rule editing (include/exclude) stays in the expanded view, unchanged.

Shared `src/renderer/src/components/SignalFeedbackModal.tsx` handles both. Modal shows: read-only history of past feedback applied (newest first, collapsible per entry); new-feedback textarea with live char counter (turns red at over-cap); submit button disabled until non-empty + under-cap. On submit, runs the corresponding research IPC with the feedback string and refreshes.

**BrandsProducts page cleanup.** Removed the per-product `Refresh signals` button (consolidated to Signal Config). Added empty-signals banners on brand panels and product cards when `research_status='ready'` but `signals` is null/empty: *"Signals not researched yet — scans won't produce leads… Go to Signal Config →"*. App.tsx passes `onNavigate` down to BrandsProducts so the inline button can route to the Signal Config page.

**Smoke tests grew 32 → 37.** Added inline copies of `validateFeedbackInput` (the trim+cap validation half of `addFeedback`) and `buildFeedbackBlockFrom` (the prompt-block assembler with the 16K-char total cap). 5 new tests:
- empty-string feedback rejected
- 4001-char feedback rejected
- 4000-char feedback accepted exactly
- empty-entries returns empty block
- newest-first ordering + oldest-drop truncation when over 16K total

Existing v1.8/v1.9 retry-on-no-citations logic untouched; deep scan two-stage path untouched; scanner / live monitor / cross-match all still read `brands.signals` and `products.signals` the same way as before — only WHO writes those columns moved.

**v1.9.1 (2026-05-27):** Widen signal-count range in research schemas.

User noticed every researched brand was landing at exactly 10 brand-level signals — that came from the `BRAND_RESEARCH_SCHEMA.signals` description in `research.ts` saying `"5-10 bullets."`. The model was honouring the upper bound. The product-level signals schema had no count hint and was converging at ~10 by LLM default.

Three schema-description rewrites in `src/main/research.ts`:
- `RESEARCH_SCHEMA.signals` (product research)
- `BRAND_RESEARCH_SCHEMA.signals` (brand research)
- `SIGNALS_SCHEMA.signals` (cheap refresh-signals call)

All three now say: *"List as many as are GENUINELY useful — minimum 1, no upper cap. Do not pad to hit a number, and do not compress to fit one. Quality over quantity: a single sharp signal beats ten generic ones."*

No DB / runtime change — `brands.signals` and `products.signals` are free-text Markdown columns with no count constraint, so the "10" was purely a prompt artefact. Existing stored signals are untouched; next time the user clicks **Run Brand Research / Run research / Refresh signals**, the new wider range takes effect.

**v1.9.0 (2026-05-27):** Two-stage deep scan. The v1.8.x deep scan was technically robust (no timeouts, no parse failures, no crashes) but Run #21 showed both products doing real research (48-50 citations, 15K completion tokens each) and returning 0 candidates each — Perplexity surfaced educational / generic content instead of specific named-company buying events. Stacking research + scoring + ICP fit + schema strictness + brand-self hygiene + scan rules into ONE model pushed it toward safe-and-empty.

Architecture (only `runDeepScan` changes; manual scan / Live Monitor / research untouched):

- **Stage 1 — Perplexity discovery** (`src/main/scanner/stage1-discovery.ts`).
  `sonar-deep-research`, 24k token budget, loose schema (only `company`, `event`, `source_url` required). Open prompt: cast a wide net of 15-30 named-company candidates with citations. No scoring, no filtering, no ICP. New `'deep_scan_discovery'` LlmStage; added to `SEARCH_REQUIRED_STAGES` so a 0-citation response triggers the v1.8.7 retry.
- **Stage 2 — Claude qualify** (`src/main/scanner/stage2-qualify.ts`).
  `claude-sonnet-4-6` (override via `settings.triageModel`), 6k token budget. Receives Stage 1's candidate list plus full brand+product dossier, target ICP, hard constraints (include/exclude rules), brand-self hygiene, recent disqualifications, and a list of companies already in the pipeline for this product in the last 30 days. Returns `{ opportunities: PplxOpportunity[], rejected: { company, reason }[] }`. Sonnet does no web search — works only on what Stage 1 surfaced; if a candidate is too thin to judge, it's dropped as unqualified rather than guessed at. New `'deep_scan_qualify'` LlmStage; deliberately NOT in `SEARCH_REQUIRED_STAGES` (no search expected).
- **Orchestrator**: `runDeepScanTwoStage()` in `scanner.ts` iterates scan-enabled products, runs Stage 1 → Stage 2 per product, and persists via the existing v1.8.4 `insertCandidates` path so URL hygiene + brand-self post-filter + confidence threshold + NOT NULL coercion all still apply. Cross-match (v1.7.0) still fires after Stage 2 inserts. `runDeepScan()` now routes by `settings.deepScanTwoStage` (default true); unchecking flips back to the v1.8.7 monolithic path as a safety net.

Settings:
- New `deepScanTwoStage: boolean` (default `true`) on the Deep Research Scan card with a help blurb. Uncheck reverts instantly to single-call mode.

Smoke tests grew 30 → 32:
- `shouldRetryResponse: deep_scan_discovery + 0 citations → retry`
- `shouldRetryResponse: deep_scan_qualify + 0 citations → keep` (no search expected)

`scanner.ts` exports `ScanLog`, `OPPS_SCHEMA`, `PplxOpportunity`, `insertCandidates`, `crossMatchRecent`, `InsertCtx` so the new stage modules can reuse them without duplication. `llm.ts complete()` accepts an optional `model` override so Stage 2 can pick Sonnet independently of the user's brief-generation default.

Cost: per-product per deep scan is ~$0.25-0.35 (Stage 1 ~$0.20-0.30 sonar-deep-research, Stage 2 ~$0.045 Sonnet) — roughly the same as v1.8.7's ~$0.20-0.40 monolithic call. For a 3-product portfolio twice daily, ~$1.50-2.10/day.

**v1.8.7 (2026-05-25):** Fix model lazy-refusal in deep scan + 7 new smoke tests.

(v1.8.6 was the pre-push hook only; no app-facing change so version stayed at 1.8.5 in the app; bumping to 1.8.7 now to keep the user-visible release line moving.)

Bug pattern (Run #20 Zyeta): deep scan returned `{"opportunities": []}` with 7 completion tokens and **0 citations**. Model produced the empty JSON shape without actually searching the web. The v1.8.5 empty-completion detector only fires on `tokens === 0 && content === ""` — this case had 7 tokens of empty-shape JSON, so the retry never fired.

Root cause: the SYSTEM prompt added in v1.8.2 contained *"If you find no qualifying opportunities, return `{"opportunities": []}` rather than omitting the JSON"* + *"Reasoning is optional; the JSON is required."* That was meant as a safety net for token-exhaustion runs, but sonar-deep-research was reading it as permission to skip research entirely.

Two-part fix in `scanner.ts` + `perplexity.ts`:

1. **SYSTEM prompt rewrite** — research is now stated as a non-negotiable first step:
   - Opens with *"YOUR JOB IS TO RESEARCH, then report."*
   - Explicit: *"An answer produced without searching is unacceptable — your response will be validated against the citations you actually consulted, and a response with zero citations is treated as a failure (the system will retry the call rather than accept it)."*
   - Removed *"Reasoning is optional"*. New framing: empty result is acceptable ONLY after genuine research.

2. **New `shouldRetryResponse(r, opts)` detector** in `perplexity.ts` — supersedes the simple `isEmptyCompletion` check in the retry loop. Returns a short reason string when retry is warranted, null otherwise:
   - **Empty completion**: 0 tokens AND 0 chars → retry (v1.8.5 behavior preserved).
   - **Lazy refusal**: stage is in `SEARCH_REQUIRED_STAGES` (`research`, `brand_research`, `brand_summary`, `refresh_signals`, `manual_scan`, `deep_scan`, `qualify`) AND `citations.length === 0` → retry. The `brief` stage is excluded since it's a pure writing task.
   - The async retry loop logs `retrying — no citations on deep_scan stage (7 completion tokens, 21 chars) — model didn't search` so the cause is visible.

Smoke test grew 23 → 30 tests:
- 7 new cases covering `shouldRetryResponse` — exact Run #20 Zyeta scenario, deep_scan-with-citations keep path, brief-stage no-retry, research/qualify retry paths, regression check that totally-empty still retries, and the conservative no-stage-given default.
- `npm run smoke` still completes in <100ms.

**v1.8.5 (2026-05-25):** Retry on empty Perplexity responses + first real smoke test.

Bug: Perplexity's async API occasionally returns `status: COMPLETED` with an empty payload (0 chars content, 0 completion tokens). The submit-and-poll flow correctly detected COMPLETED and returned the empty response as if successful, causing downstream "unparseable response (0 chars)" failures.

Fix in `perplexity.ts`:
- `completePerplexityAsync` refactored: extracted `submitAndPollOnce` as the inner submit-and-poll cycle, wrapped in a one-retry loop in the outer function.
- New `isEmptyCompletion(r)` helper: `completion_tokens === 0 AND content.length === 0`.
- On empty response, log `[perplexity-async] empty completion … retrying` and submit a fresh job after a 2s pause.
- If the second attempt is ALSO empty, throw a clear error: `"Perplexity returned an empty completion twice in a row … likely a transient Perplexity API issue"`. Scanner's per-product catch handles it gracefully.
- Spend is still recorded on the FIRST empty completion (Perplexity may bill for search even when content was empty); the second attempt records again on success.

Bonus fix caught by the smoke test: `cleanUrl` in `url-hygiene.ts` was single-pass — for inputs like `"(https://example.com/path)."` the trailing-punct regex stripped the `.` but left the closing `)`, and the wrap-stripper had already missed it because it wasn't at the very end yet. Made the strip loop iterate to stable, which handles arbitrary nesting.

New: `scripts/smoke-perplexity.mjs` — first proper smoke test for the pure-function logic that's been biting us:
- 8 tests on `tryParseJson` (real sonar-deep-research output shapes: think blocks, fences, sequential blocks, escaped quotes, truncated mid-reasoning)
- 4 tests on `isEmptyCompletion`
- 5 tests on `cleanUrl` / `pickBestSourceUrl`
- 6 tests on `isOwnBrandCompany` including the v1.8.3 regression
- `npm run smoke` runs them in ~50ms. `npm run preship` runs smoke then dist:mac.

The smoke test inlines copies of the production functions because the real modules pull in electron / undici / better-sqlite3 / settings.js which can't run under bare Node. The inlined copies must stay byte-identical with production — manual sync flagged in the file header. Move to vitest with proper module mocking once test surface grows beyond ~30 tests.

**v1.8.4 (2026-05-25):** Crash fix — `scan:runDeep` was failing with `SqliteError: NOT NULL constraint failed: opportunities.headline` when Perplexity returned a candidate without a `headline` field. The whole scan run aborted on the first such candidate.

Root cause: `response_format: json_schema` marks `headline` as required, but Perplexity's enforcement isn't perfectly strict — the model occasionally omits or nulls required fields, especially in long deep-research outputs. The Live Monitor's `qualify.ts` already had a fallback (`j.headline || item.title`); the scanner's `insertCandidates` did not.

Two fixes in `scanner.ts` → `insertCandidates`:
1. **Defensive coercion** before insert:
   - `company`: must be non-empty after trim; skip with `missing company` log if not.
   - `headline`: fall back to `${company} — ${matched_signal}` → `source_title` → `${company} — opportunity` if missing.
   - `source_title`: fall back to `attrib.sourceLabel` → `'(scan)'`.
   - `industry`, `background`, `use_case`, `angle`, `signal_summary`: explicit `|| null` so empty strings become null rather than being stored as `""`.
   - `confidence`: defaults to `0` if absent (will then fail the minConfidence gate naturally).
2. **Per-candidate try/catch** around the insert. If any single candidate fails to insert (NOT NULL, FK, anything), it's logged with the error message and the scan continues with the next candidate. Previously one bad candidate killed the whole scan.

**v1.8.3 (2026-05-25):** Brand-self filter false-positive fix + 0-candidate diagnostics.

Bug: `normalize()` in `lead-hygiene.ts` was stripping descriptive words like `software`, `technology`, `systems`, `solutions`, `services`, `group`, `holdings` from trailing positions. So "Neptune Software" normalized to just **`neptune`**, and the substring match silently filtered every company whose name contains "neptune" — Neptune Energy, Neptune Wellness Solutions, etc. For brands with unique names this didn't matter; for brands with common name stems it dropped legitimate leads.

Fix in `lead-hygiene.ts`:
- Suffix-strip list reduced to TRUE legal-entity suffixes only: `inc / incorporated / ltd / limited / llc / plc / gmbh / sa / nv / bv / co / company / corp / corporation / ag / kg / kk / sas / sarl`. "Neptune Software" now normalizes to `neptune software`, not `neptune`.
- Added `SHORT_STEM_THRESHOLD = 5`: substring matching is gated by length. Stems ≤ 4 chars require exact-equality, not substring. So a brand "Acme" or "Zyeta" can't silently filter every company containing those letters.

Two new scanner diagnostics:
- **0 candidates but citations > 0** → log "model consulted N sources but surfaced no opportunities" with the top-3 citation URLs as a sample. Lets you see what Perplexity actually searched even when the model didn't pick anything.
- **All returned candidates below minConfidence** → log the confidence distribution like `! all 4 candidates below minConfidence 0.55: [0.45, 0.48, 0.50, 0.52]. Lower threshold in Settings to surface them.` So you know when the threshold is the bottleneck.

**v1.8.2 (2026-05-25):** Fix — deep scan with rich prompts was running out of token budget mid-reasoning before producing JSON. Diagnostic in v1.7.6 confirmed: response of 40,452 chars ending with `</think>` and no JSON output.

Root cause: `sonar-deep-research` mixes `<think>` reasoning blocks into the completion stream. With `maxTokens: 9000` and v1.6+'s rich prompts (brand dossier + product dossier + 5 knowledge chunks + signals + rules + disqualifications + own-brands hygiene + task), the model spends the entire budget on reasoning and never emits JSON.

Three fixes in `scanner.ts`:
1. Bumped `maxTokens` for deep scan **9000 → 24000**. Adds enough headroom for reasoning + JSON together. Cost impact: marginal — most calls won't actually use all 24K, this is just the ceiling.
2. SYSTEM prompt updated with explicit instruction: "You MUST end your response with valid JSON matching the schema. Your reasoning may be extensive but the JSON output is the deliverable — prioritize finishing the JSON over additional reasoning. If you find no qualifying opportunities, return `{"opportunities": []}` rather than omitting the JSON."
3. Diagnostic logs:
   - Every scan response now logs `completion_tokens` (so you can see how much of the budget was used)
   - On unparseable response, additionally detects `text.endsWith('</think>')` and emits a clear `detected: response ended inside <think> block — model ran out of token budget` hint
   - On deep-scan responses with **0 candidates AND 0 citations**, log a `suspicious: deep scan returned 0/0` warning + head preview, because that combination means sonar-deep-research didn't actually search (Perplexity-side hiccup, immediate cache miss, etc.) and needs investigation

**v1.8.1 (2026-05-25):** Recency at-a-glance. v1.8.0 stored the auto/override values but only surfaced them deep inside Edit modals and scan logs. Now visible everywhere:
- New `RecencyChip` component on BrandsProducts: rendered next to the `scans on/paused` chip on the brand header and on every product card. Shows the short label + `(auto)` vs `(override)` indicator.
- Scan Jobs → Scan inclusion card: each brand row and each product row now shows an inline recency pill (purple = override, green = auto, grey muted = global fallback). Tooltip explains the source.
- Mirrors the backend `resolveScanRecency()` precedence: product override → product auto → brand override → brand auto → global.

**v1.8.0 (2026-05-25):** Per-brand / per-product scan recency with auto-recommendation from research.

Problem solved: forcing one global `scanRecency` across the whole portfolio is fundamentally wrong. Zyeta (workspace design) needs 12-month windows for premises decisions; a cybersecurity brand needs 7-day windows for breaches. v1.8 lets each brand and product pick its own — auto-derived from research, with a manual override slot.

Schema additions (all idempotent):
- `brands.scan_recency_auto` TEXT — set by `researchBrand`.
- `brands.scan_recency_override` TEXT — user manual choice; null = use auto.
- `products.scan_recency_auto` TEXT — set by `researchProduct`.
- `products.scan_recency_override` TEXT — user manual choice; null = use auto.

Brand type and Product type widen `scan_recency_*` fields to `'day' | 'week' | 'month' | 'year' | null`.

Research integration:
- New `recommended_scan_recency` field added to `BRAND_RESEARCH_SCHEMA` and `RESEARCH_SCHEMA` (product) — enum `day|week|month|year`. The schema description tells the model how to choose: hyper-time-sensitive (day), fast-cycle (week), medium (month), slow-cycle multi-quarter decisions (year).
- `researchBrand()` and `researchProduct()` persist the chosen value into `scan_recency_auto`.

New module: `src/main/recency.ts`
- `resolveScanRecency(product, brand, settings?)` returns `{ value, source }` where source is `'product_override' | 'product_auto' | 'brand_override' | 'brand_auto' | 'global'`. Resolution order is most-specific-first.
- `recencyHumanLabel(r)` for UI rendering.

`scanner.ts` integration:
- Pass 1 per-product loop calls `resolveScanRecency(product, brand)` and uses the value both in the prompt text (`Only consider events from the last X`) and in the API parameter (`search_recency_filter`). Logs `recency: <value> (from <source>)`.
- Pass 2 custom topics: if pinned to a product, inherit that product's resolved recency; otherwise fall back to global.

UI:
- Brand edit modal: new "Scan recency window" dropdown. Default option shows `Auto (Last X — from brand research)` if the brand has been researched, else `Auto (uses global setting until brand research runs)`. Manual override options for each window. Saving null clears the override.
- Product edit modal: same dropdown, with helper text noting per-product overrides win over the brand setting.
- IPC handlers `brands:update` and `products:update` accept `scan_recency_override` via explicit `'in' payload` check (so null clears the override rather than being ignored by COALESCE).

Existing users: brands and products researched before v1.8 won't have `scan_recency_auto` set yet — re-run research to populate. Until then, the resolver falls through to the global `settings.scanRecency`.

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

## 10a. Pending architectural work

- (Empty — v1.9.0 two-stage deep scan shipped 2026-05-27. The spec at
  `docs/v1.9.0-two-stage-deep-scan.md` is preserved for historical reference.)

## 11. Live links

- **Repo:** https://github.com/reigntimelesssanctuary/LeadsHawk
- **v1.0.0 release + DMG:** https://github.com/reigntimelesssanctuary/LeadsHawk/releases/tag/v1.0.0
- **Local DMG (Apple Silicon):** `release/LeadsHawk-1.0.0-arm64.dmg`
- **Runtime data:** `~/Library/Application Support/LeadsHawk/data/leadshawk.db`
- **Runtime settings:** `~/Library/Application Support/LeadsHawk/settings.json`
