# LoveLive! CD Collection & Live Board

A small, dependency-free fan dashboard for one person's LoveLive! shelf and news feed:

- **CD collection checklist** - tick the CDs you own, filter by group / album / song, and watch a live progress bar.
- **News & events board** - releases, merchandise, popup stores and live events, with upcoming events first and past events dimmed.
- **Scheduled scraper** - a GitHub Actions job appends new official headlines to `data.json` every day.

Everything is plain HTML, CSS and JavaScript. There is no framework, no bundler and no backend.

> Unofficial fan project. All titles, artwork and event details belong to their respective rights holders. Always confirm bonus goods, ticket windows and dates on the official site before spending money.

---

## 1. What is in the box

```
.
├─ index.html                     # the whole dashboard (markup + inline data snapshot)
├─ styles.css                     # pastel theme, card grid, responsive layout
├─ app.js                         # data loading, filters, sorting, localStorage ticks
├─ data.json                      # the single source of truth
├─ README.md
├─ .gitignore
├─ .github/
│  └─ workflows/
│     └─ scrape.yml               # daily scheduled scraper
├─ scraper/
│  ├─ package.json
│  ├─ config.json                 # sources + CSS selectors (no secrets)
│  └─ scrape.js                   # axios + cheerio scraper
└─ tools/
   ├─ import-discography.mjs     # rebuild cds[] from the official discography pages
   └─ sync-fallback.mjs          # copies data.json into index.html
```

## 2. Quick start

1. Install [Node.js 20+](https://nodejs.org/) (only needed for the scraper and the sync helper; the page itself runs without Node).
2. Open a terminal in this folder and start a static server:

   ```bash
   python -m http.server 8080
   ```

   Then visit <http://localhost:8080/>.

   You can also double-click `index.html`, but browsers block `fetch()` on `file://` URLs. The page then falls back to the inline snapshot and the badge in the header says **Inline snapshot (file:// mode)**.

3. Tick some CDs. The state is saved in your browser under `lovelive-tracker.owned.v1`.

> **Do not open `index.html` via `file://` and expect fresh data.** Editing `data.json` only shows up over HTTP(S) until you run `node tools/sync-fallback.mjs`.

## 3. Data flow

```
lovelive-anime.jp  --(scraper, daily)-->  data.json  --(fetch)-->  app.js  -->  page
        |                                     |
        |                                     +--(tools/sync-fallback.mjs)--> index.html inline snapshot
        |
        +--(manual edits for type / bonuses / tickets / locations)
```

- The scraper **only appends new titles and links** (plus a date when it can parse one).
- Everything that needs judgement - `type`, `specialOffer`, `ticketInfo`, `location` - stays `TODO` on scraped rows so you can fill it in deliberately.
- The `cds` array is never touched by automation.
- De-duplication happens on `officialLink`, so running the scraper twice does not create duplicates.

## 4. Front-end behaviour

### CD checklist

- Combined filters: group (select), album title (substring, case-insensitive), song (substring, case-insensitive).
- Sorts: release date newest/oldest, group order, owned first, not owned first. Missing dates always sort last.
- Progress bar counts every CD in `data.json`, not just the filtered subset; the "Showing X of Y" chip tells you how many cards are visible.
- The `owned` field in `data.json` is only the initial default. Once you tick a box, your choice is stored in `localStorage` as an override keyed by CD `id`. Unknown ids are ignored, so deleting a CD from `data.json` is safe.
- If `localStorage` is blocked (private mode, strict settings), a yellow banner appears and ticks last until reload.

### News & events

- Filters: type, group, free-text search over title + description, and "hide past events".
- Sorting: **Upcoming first** (next event soonest, past events last, newest past first) or **newest first**.
- Past events (date before today, local timezone) show an `Ended` badge and are dimmed.
- `Date TBD` is shown when the date is missing or malformed, and those items sort last.
- Every card links to the official page with `View Details ↗`.
- Empty or `TODO`-only news fields are hidden, so freshly scraped cards stay readable: only confirmed text is shown. CD cards likewise hide an empty track list and an empty special-offer box; only the hand-written seed CDs still carry explicit `TODO` prompts.
- All text is inserted with `textContent` / DOM APIs, never concatenated into `innerHTML`, so scraped content cannot inject markup.

### Date handling

Dates are compared as `YYYY-MM-DD` strings using the visitor's local calendar day. This avoids the classic `new Date('2026-01-23')` UTC off-by-one bug where a date appears one day early in western timezones.
## 5. Editing `data.json`

`data.json` is strict JSON: it has no comments. Notes live in the top-level `_comment` array, and unfinished fields contain literal `TODO` strings. Keep both `cds` and `news` arrays even when one is empty.

### `cds[]`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | Unique. Used as the localStorage key suffix - never reuse an id for a different CD. |
| `group` | string | yes | `μ's`, `Aqours`, `Nijigasaki`, `Liella!`, `Hasunosora` or `All` (series-wide releases). A new value still renders, just without a themed colour. |
| `artistOrUnit` | string | no | Shown as a grey tag when it differs from `group`. |
| `albumTitle` | string | yes | Main title on the card. |
| `releaseDate` | string | no | `YYYY-MM-DD`. Empty or invalid means "Release date TODO" and sorts last. |
| `songs` | string[] | no | Shown as small pills. An empty array hides the section (imported rows without a static track list). |
| `specialOffer` | string | no | First-press / store bonus (特典) text. Rendered in the highlighted box; empty hides the box. |
| `imageUrl` | string | no | Absolute `http(s)` URL or a relative `assets/...` path. Empty shows a pastel group-initial placeholder. |
| `officialLink` | string | no | `http(s)` only. Anything else becomes "Official link TODO". |
| `owned` | boolean | no | Initial tick state. Overridden by your localStorage choice. |

### `news[]`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | Unique. Scraped rows use `scraped-<sha1(link)[0:12]>`. |
| `type` | string | yes | `CD Release`, `Merch`, `Popup/Collab Store`, `Live` or `Uncategorized`. Used by the type filter and badge colour. |
| `title` | string | yes | Headline. |
| `date` | string | no | `YYYY-MM-DD`. Missing/invalid shows `Date TBD`. Past dates get the `Ended` badge. |
| `location` | string | no | Venue / city / store. `N/A` hides the line. |
| `ticketInfo` | string | no | Lottery and sale details. Shown for `Live` items and for any item with a value other than `N/A`. |
| `specialOffer` | string | no | Bonus goods / purchase bonus. Rendered in the highlighted box. |
| `description` | string | no | One or two sentences. Also searched by the free-text filter. |
| `imageUrl` | string | no | Same rules as the CD cards. |
| `officialLink` | string | no | Required for `View Details ↗`; also the scraper's de-duplication key. |
| `group` | string | yes | Same group values as CDs, plus `All` for series-wide news. |

### Add or update an entry by hand

1. Append an object to the right array (or edit the `TODO` text of an existing one).
2. Keep `id` unique and `officialLink` exactly as the site uses it.
3. Validate and refresh the inline snapshot:

   ```bash
   node -e "JSON.parse(require('fs').readFileSync('data.json','utf8')); console.log('valid')"
   node tools/sync-fallback.mjs
   node tools/sync-fallback.mjs --check   # exits 1 if the snapshot is stale
   ```

4. Reload the page over HTTP and confirm the card renders.

## 6. Scraper

```bash
cd scraper
npm install
npm run scrape        # fetch, append new items, rewrite ../data.json
npm run scrape:dry    # same work, but never writes (recommended first run)
```

What it does:

1. Reads `config.json` and `../data.json` (refusing to continue if the JSON is malformed, so a typo cannot wipe your data).
2. Requests each source with a browser-like User-Agent, `Accept-Language: ja`, a 20 s timeout and a configurable delay between sources.
3. Extracts, per matched item: title, date (normalised from `2026.01.23`, `2026/01/23` or `2026年1月23日`) and an absolute link.
4. Appends only items whose `officialLink` (or shared `01_xxxx` article number) is not already in `data.json`, and writes the file back with 2-space indentation when something changed.
5. Prints a per-source report and exits 0 even when individual sources fail.

Scraped rows are deliberately incomplete: `type` starts as `Uncategorized`, `location` and `description` are empty, and `ticketInfo` / `specialOffer` are `TODO`. The 23 headlines shipped in `data.json` received a one-off manual type classification so the filter is useful out of the box; every future scraped row still needs your judgement.

### `scraper/config.json`

| Key | Purpose |
| --- | --- |
| `requestDelayMs` | Pause between sources. Keep it at 1500 ms or higher. |
| `sources[].name` | Human label used in the log report. |
| `sources[].url` | News page to fetch. |
| `sources[].group` | Group assigned to every scraped item from this source. |
| `sources[].baseUrl` | Base used to resolve relative links. |
| `sources[].itemSelector` | One element per news row. |
| `sources[].titleSelector` | Title inside the row. Falls back to the row text when it matches nothing. |
| `sources[].dateSelector` | Date inside the row. Optional. Handles `p.date`, `2026.11.24` and split `<time datetime="2026">` + `<time datetime="11-24">` markup. |
| `sources[].linkSelector` | Link inside the row. Leave it as `""` when the matched row is itself the `<a>`. |
| `sources[].groupSelector` | Optional. Per-item group label (used by the aggregate portal). |
| `sources[].groupMap` | Optional. Maps the label text to a group name; unmapped labels fall back to `sources[].group`. |

**The shipped selectors were verified against the live HTML on 2026-11-24.** They cover the five group News pages (`topics.php`, `topics/`, `news/`) and the aggregate portal. The group pages all list rows as `<li><a><p class="date">...</p><p class="title">...</p></a></li>` (Hasunosora uses `span.list--date` / `span.list--text`), while the portal uses `a.p-newslist` with a series label in `.p-newslist__category` that `groupMap` translates into a group name. Because the group sites are scraped first, their entries win the group attribution; the portal only adds stories the group pages did not list. The same story can appear as `/news/01_6863.html` and as `/nijigasaki/detail.php?p=01_6863`, so the scraper collapses mirrors by the shared `01_xxxx` number.

Markup changes: when a selector stops matching, the source logs `matched 0 elements` and is skipped without aborting the run. Inspect the page and update `scraper/config.json`.

### Importing the full discography

`tools/import-discography.mjs` rebuilds the `cds` array from the five official discography pages, one card per edition. It reuses the dependencies already installed in `scraper/node_modules` and is safe to re-run.

```bash
node tools/import-discography.mjs                     # dry-run report, writes nothing
node tools/import-discography.mjs --write             # append/update cds[] in data.json
node tools/import-discography.mjs --write --refresh   # also refill empty song arrays
node tools/sync-fallback.mjs                          # refresh the file:// snapshot
```

| Group | Page | Rows parsed |
| --- | --- | --- |
| μ's | `otonokizaka/release.php` | `.titlebase` inside `.box`, details from `.text` |
| Aqours | `uranohoshi/cd.php` | `.box` containing `.cover`, title from `.llbox`, details from `.text` |
| Nijigasaki | `nijigasaki/cd.php` | `.box` containing `.title`, `dt`/`dd` pairs and `ul.track li` |
| Liella! | `yuigaoka/music/` | `.jkt` anchors (`.title`, `.subtitle`, `.date`) plus one detail fetch per release |
| Hasunosora | `hasunosora/music/` | `.list--block` (`.list--headline`, `.list--title`, `.list--desc__date`) |

Rules the importer applies:

- **One entry per edition.** `CD+DVD` singles stay; Blu-ray, DVD-only and live-video products are skipped, as are rows whose title is still `タイトル未定`.
- **Dates** are normalised to `YYYY-MM-DD`. Old μ's rows that only say `4月2日発売` infer the year from the nearest dated neighbours; three ambiguous rows have explicit overrides in the script.
- **Stable ids** are `disc-<group>-<sha1(title|date)[0:10]>`. The five original seed CDs are matched by title + release date and enriched in place, so their ids (and therefore your localStorage ticks) never change. Existing rows are never deleted.
- **Cross-listed releases** (same title + date on several group pages) are stored once with `group: "All"`; the current run collapses 8 rows this way.
- **Imported rows** get `owned: false`, empty `specialOffer` / `imageUrl`, and songs parsed from the page. Hasunosora track lists are rendered by JavaScript, so those cards legitimately have `songs: []` and simply hide the section.
- **Liella!** needs one detail-page request per release (~62 today), so a full run takes about a minute.
- **Safety:** `--write` refuses to touch `data.json` if any source fails, and repeat runs are idempotent. `--refresh` only fills song arrays that are still empty; it never overwrites your own edits.

The current dataset holds **369 CDs** (μ's 76, Aqours 95, Nijigasaki 71, Liella! 57, Hasunosora 65, series-wide `All` 5), imported on 2026-11-24.

## 7. GitHub Actions

The workflow lives at `.github/workflows/scrape.yml` (repository root - that path is mandatory for GitHub to discover it).

- Schedule: `0 0 * * *` = daily at 00:00 UTC = **08:00 Hong Kong time**.
- Manual run: **Actions -> Update LoveLive news -> Run workflow**.
- `permissions: contents: write` lets the bot push `data.json`; `concurrency` prevents overlapping runs.
- After scraping it validates the JSON, syntax-checks `app.js`, syncs the inline snapshot, then commits both files with `[skip ci]`.

If you fork this repository, enable **Settings -> Actions -> General -> Workflow permissions -> Read and write permissions**, otherwise the push step fails.

## 8. Honesty, limits and data provenance

- **Seed CDs** use real, documented release dates: μ's *Snow halation* (2010-12-22), Aqours *恋になりたいAQUARIUM* (2016-04-27), Nijigasaki *TOKIMEKI Runners* (2018-11-21), Liella! *始まりは君の空* (2021-04-07) and Hasunosora *Dream Believers* (2023-03-29). Their track lists were typed by hand and kept as-is by the importer.
- **Discography**: the remaining 364 editions were collected from the official group discography pages on 2026-11-24. Titles, dates, artists and track lists come from those pages only; nothing was invented. Where the page lists several editions, each edition is its own card. Blu-ray / DVD-only products and `タイトル未定` placeholders are excluded. Hasunosora track lists are client-side rendered, so 64 of their 65 cards show no songs (the section is hidden rather than filled with guesses); one Aqours theme-song CD also has no published track list. `specialOffer` and `imageUrl` stay empty until you add them.
- **News**: 23 headlines were harvested from the official group News pages on 2026-11-24 (dated 2026-11-14 to 2026-11-24), plus one historical μ's Final LoveLive entry (2016) kept as a past-event example. Harvested rows carry only a headline, date, group and link; `description`, `ticketInfo` and `specialOffer` remain empty / `TODO`. The development-only `SAMPLE ENTRY` placeholders were removed, so nothing on the board is invented.
- **No X/Twitter scraping.** There is no free API and the anti-bot rules are strict. Check official accounts manually.
- **No news detail-page crawling**, so bonuses, ticket windows and locations are never invented by the daily scraper - they remain `TODO` until a human fills them in. Only the discography importer follows Liella! detail links, and only to read track lists.
- **No images are bundled.** Empty `imageUrl` values render a safe pastel placeholder instead of hot-linking copyrighted artwork. To use official art, host it yourself or link to it deliberately.
- The site's markup can change at any time; the scraper is best-effort by design.

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Page is empty / header says `Data load failed` | Opened via `file://` and the inline snapshot is also invalid | Serve over HTTP; run `node tools/sync-fallback.mjs`; check the browser console. |
| Badge says `Inline snapshot (file:// mode)` | `fetch()` blocked by the browser | Expected on `file://`. Use `python -m http.server 8080` for canonical data. |
| Ticks disappear after reload | localStorage blocked or cleared | Allow site data for the origin; check the yellow banner. |
| Scraper logs `403` / timeouts for every source | The site may throttle or block automated clients intermittently | Re-run later; the JSON is left untouched when nothing is scraped. Respect the site terms of use. |
| Scraper logs `matched 0 elements` | Markup changed, or a page moved | Open the page, inspect a row, and update `scraper/config.json`. |
| Workflow never runs | File is not at `.github/workflows/`, Actions disabled, or the schedule was just added (GitHub can delay the first run) | Move the file, enable Actions, use "Run workflow" once. |
| Workflow push rejected | Read-only `GITHUB_TOKEN` | Set workflow permissions to "Read and write". |
| `sync-fallback --check` fails in CI | Someone edited `data.json` without syncing | Run `node tools/sync-fallback.mjs` and commit `index.html`. |

## 10. Customising

- **Colours**: edit the tokens in `:root` in `styles.css`, then the `.group-*` / `.type-*` blocks.
- **New group**: add it to `GROUP_ORDER`, `GROUP_CLASS` and `GROUP_INITIAL` in `app.js`, plus a `.group-<slug>` colour pair in `styles.css`.
- **New news type**: add it to `TYPE_ORDER` and `TYPE_CLASS` in `app.js`, plus a `.type-*` colour in `styles.css`.
- **Different schedule**: change the cron line in `.github/workflows/scrape.yml`. GitHub cron is always UTC.
- **More sources**: append objects to `scraper/config.json`; the delay, de-duplication and reporting apply automatically.