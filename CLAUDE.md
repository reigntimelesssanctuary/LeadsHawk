# CLAUDE.md — LeadsHawk

This file is the orientation guide for any future Claude (or human) working on
this codebase. It captures what the project is, how it's wired together, the
design choices baked in, and the user's collaboration preferences.

---

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
| LLM (research + scan) | **Perplexity API** (`sonar-deep-research`, `sonar-pro`) — direct `fetch` calls, no SDK |
| LLM (sales brief) | `@anthropic-ai/sdk` (Claude) |
| News discovery | Perplexity's built-in live web search (no separate RSS fetch). Legacy `rss-parser` is still installed but unused; the signal-source `kind` field is now informational only. |
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
    │   ├── index.ts               ← App entry: creates BrowserWindow, wires IPC, starts scheduler
    │   ├── db.ts                  ← SQLite open + migrations
    │   ├── settings.ts            ← electron-store wrapper for user settings
    │   ├── llm.ts                 ← Anthropic client wrapper + completeJson() helper
    │   ├── knowledge.ts           ← File extraction (PDF/PPTX/DOCX/TXT/HTML) + URL fetch+strip
    │   ├── research.ts            ← Product research pipeline (calls LLM, persists dossier)
    │   ├── scanner.ts             ← News fetch → URL dedupe → LLM qualify → store opportunity
    │   ├── scheduler.ts           ← node-cron wrapper. Reads scanCron + scanEnabled from settings
    │   ├── dispatch.ts            ← Sales brief generator + dispatch log
    │   └── ipc.ts                 ← All ipcMain.handle() endpoints + seedDefaults()
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
            │   └── Modal.tsx      ← Generic modal dialog
            └── pages/
                ├── Dashboard.tsx
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
  - `brands(id, name UNIQUE, description, positioning, competitive_summary, …)`
  - `products(id, brand_id→brands, name, description, category, use_cases, competitors, differentiators, signals, research_status, research_summary, scan_enabled, …)`
    — `scan_enabled` (default `1`) toggles whether autonomous scans run for this product. Added via idempotent `addColumnIfMissing` in `db.ts` so old DBs upgrade in place.
  - `knowledge_items(id, brand_id, product_id?, kind: 'file'|'link'|'note', title, source, content, status, …)`
  - `signal_sources(id, name, kind: 'google_news'|'rss'|'query', config JSON, enabled, …)`
  - `scan_jobs(id, cron, enabled, last_run_at, last_status, last_results, …)`
  - `scan_runs(id, started_at, finished_at, status, items_scanned, opportunities_created, log, …)`
  - `opportunities(id, brand_id?, product_id?, company, industry, headline, source_url, source_title, source_published_at, confidence, status: 'open'|'qualified'|'disqualified'|'archived', background, use_case, angle, signal_summary, raw_signal, …)`
  - `dispatch_log(id, opportunity_id, target, payload, result, …)`
  - `seen_urls(url PRIMARY KEY, seen_at)` — dedupe across scans
  - `scan_rules(id, kind: 'include'|'exclude', text, enabled, created_at)` — user-defined hard constraints injected into every scan prompt

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
  Two passes, both of which receive a shared **guardrails block**
  (`buildGuardrails()`) derived from enabled `scan_rules`:
  - The block lists the user's `include` rules as ALL-must-pass and
    `exclude` rules as ANY-blocks. It is told to outrank everything else
    and to return an empty `opportunities` array if nothing satisfies the
    rules. The block is prepended to the prompt's task section in both
    passes.

  **Pass 1 — auto signals from products (primary).**
  - Iterate over every product where `research_status='ready'` and
    `scan_enabled=1` and `signals` is non-empty.
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

- **`pages/ScanJobs.tsx`** — Schedule editor (cron + enable toggle +
  presets: Every hour / 6h / Twice daily / Daily 9am), manual "Run Scan
  Now" panel, and a paginated history of `scan_runs` with click-through to
  view logs in a full-screen overlay.

- **`pages/SignalConfig.tsx`** — Three sections:
  1. **Auto-derived signals (primary).** Lists every researched product
     with an enable/disable checkbox + an expand caret. Expanding shows
     the bulleted signal list captured by deep research. Toggling fires
     `products.setScanEnabled(id, bool)`. When no products are researched
     yet, shows a friendly warning pointing back to Brands & Products.
  2. **Scan guidance — include & exclude rules.** Two-column card
     (Always include / Always exclude). Each rule is a free-text line,
     persisted in `scan_rules`, with a per-rule enable checkbox + delete.
     Rules are HARD CONSTRAINTS injected into every Perplexity prompt
     (both auto-signal Pass 1 and custom-topic Pass 2). If no candidates
     satisfy the rules, Perplexity is told to return an empty array.
  3. **Advanced — custom topics (collapsed by default).** Optional
     free-form Perplexity search topics. Add with a single-form modal
     (`name` + `query`). These rows live in `signal_sources` and feed
     scanner Pass 2.

- **`pages/BrandsProducts.tsx`** — Two-pane layout. Left: 240px brand list.
  Right: the selected brand's panel containing (a) editable brand metadata
  + competitive summary, (b) products list with per-product "Run research"
  buttons and collapsible dossier details, (c) the knowledge base with
  *Upload Files / Add Link / Add Note* buttons.

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
- **No icon.icns.** Electron-builder falls back to the default Electron
  icon. Drop a real `build/icon.icns` and re-enable
  `"icon": "build/icon.icns"` in `package.json > build.mac`.

---

## 11. Live links

- **Repo:** https://github.com/reigntimelesssanctuary/LeadsHawk
- **v1.0.0 release + DMG:** https://github.com/reigntimelesssanctuary/LeadsHawk/releases/tag/v1.0.0
- **Local DMG (Apple Silicon):** `release/LeadsHawk-1.0.0-arm64.dmg`
- **Runtime data:** `~/Library/Application Support/LeadsHawk/data/leadshawk.db`
- **Runtime settings:** `~/Library/Application Support/LeadsHawk/settings.json`
