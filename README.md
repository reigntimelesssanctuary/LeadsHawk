# LeadsHawk

**B2B Signal Intelligence** — a Mac-native desktop app that autonomously hunts
for corporate sales opportunities for the brands and products you sell.

LeadsHawk:

1. **Learns** your portfolio. You give it the brands and products you sell. It
   ingests PDFs, PowerPoints, links, and free-text notes, then runs deep
   competitive research (powered by Claude) to understand each product, its use
   cases, its differentiators, and the signals that indicate a buying
   opportunity.
2. **Listens** for signals. On a schedule you control, LeadsHawk scans the open
   web (Google News and any RSS feeds you add) for the events you care about.
3. **Qualifies** opportunities. For every signal, it cross-references your
   portfolio and decides — honestly — whether the situation is a genuine
   opportunity. Only items above your confidence threshold land in your inbox.
4. **Briefs** sales. Each qualified opportunity comes with company background,
   the justified use case, a recommended sales angle, and a one-click brief
   you can hand to an AE.

## Quick start

### 1. Run the app in development

```bash
npm install
npm run dev
```

### 2. Build a distributable Mac app (.dmg)

```bash
npm run dist:mac
```

The DMG lands in `release/`. Double-click it and drag LeadsHawk to Applications.

> First launch on macOS: right-click the app and choose **Open** (since the
> build is not code-signed). This only matters the first time.

### 3. Configure your API key

Open the app → **Settings** → paste your Anthropic API key
(get one at https://console.anthropic.com). Save.

### 4. Add a brand and run research

1. **Brands & Products** → *Add Brand* → enter a name (e.g. *Juniper Networks*).
2. Add one or more products under that brand.
3. Upload product documentation (PDF / PPT / DOCX), add link sources, or paste
   in free-form notes under **Knowledge Base**.
4. Click *Run research* on each product. LeadsHawk produces a competitive
   dossier: use cases, competitors, differentiators, and the signals to watch
   for in news.

### 5. Turn on the autonomous scanner

1. **Signal Config** → review the default signal sources (Google News queries).
   Add your own if you have specific tracking needs.
2. **Scan Jobs** → enable autonomous scans and choose a cadence (default: every
   6 hours).
3. **Dashboard** → *Run Scan Now* for an immediate test.

Qualified items will appear on the **Dashboard** under *Open Opportunities*.
Click any row to see the full background, use case, sales angle, and source
news article. Use the *Generate brief* button to produce a one-page sales
brief.

## Architecture

- **Electron 33** shell, Mac-native window
- **React 18 + TypeScript + Vite** renderer (UI)
- **better-sqlite3** for local storage (no cloud sync — everything is on your
  machine, in `~/Library/Application Support/LeadsHawk/data/`)
- **Anthropic Claude SDK** for product research and opportunity qualification
- **rss-parser** + Google News RSS for signal ingestion
- **node-cron** for scheduled scans

## Privacy

LeadsHawk runs entirely on your Mac. The only outbound traffic is:

- Anthropic API calls (your prompts + the fetched news content)
- Google News RSS fetches (public)
- The URLs you choose to enrich (public pages only)

No telemetry. No cloud accounts. No data leaves your machine except as
described above.

## Project layout

```
src/
  main/         Electron main process (Node)
    db.ts          SQLite migrations & connection
    settings.ts    Persisted user settings (electron-store)
    llm.ts         Anthropic client wrapper
    knowledge.ts   PDF / DOCX / PPTX / URL extraction
    research.ts    Product research pipeline
    scanner.ts     News fetch + LLM qualification
    scheduler.ts   Cron-based autonomous scanner
    dispatch.ts    Sales brief generation
    ipc.ts         IPC handlers exposed to the renderer
    index.ts       Main entry / window creation
  preload/      contextBridge between main & renderer
  renderer/     React UI
  shared/       Shared TypeScript types
```

## License

MIT
