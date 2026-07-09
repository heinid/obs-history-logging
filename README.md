# History Logging

An Obsidian plugin for studying history by organising notes on a **chronological
timeline** driven by simple year tags.

## Year tags

Dates are written as hierarchical tags so Obsidian's native tag tree doubles as a
time tree:

| Tag | Meaning |
| --- | --- |
| `#ad/07/1/0` | year 710 AD (exact) |
| `#ad/07/1` | 710–719 (decade bucket) |
| `#ad/07` | 700–799 (century bucket) |
| `#bc/07/1/0` | year 710 BC |

A year is zero-padded to four digits `ABCD` and split as `AB / C / D`. Because
these are ordinary tags they remain searchable and clickable, and coarser tags
group finer ones.

The grammar is strict: the first segment is exactly two digits (century), the
optional second and third are exactly one digit each (decade, year). Anything
else — `#ad/1912`, `#ad/19/12` — is not a year tag and is ignored.

## Events and summaries

Any year tag can carry a **summary / narrative** that you write yourself. When
you add one, the tag is wrapped inline:

```
奈良時代 710年 – 794年 {ev k7f3a9x1 #ad/07/1/0 }
```

- `{ev <id> ... }` binds a globally-unique id to the tag. In Live Preview and
  reading mode the structure is folded away, leaving the native tag plus a small
  ⌛ marker.
- The summary text lives in a single markdown data file (default
  `_chronology/events.md`), keyed by the id — nothing long is stored inline.
- This grammar is deliberately separate from any annotation plugin syntax.

### Usage

1. Type a year tag such as `#ad/07/1/0` in a note.
2. Put the cursor on the tag and run **Add event to year tag under cursor**.
3. Write the summary in the dialog and save.
4. Click the ⌛ marker any time to view/edit the summary or jump back to the
   source.

## Era systems

An *era system* is one civilization's complete, sequential chronology (Japan,
China, Britain, Rome…). Picking a system from the timeline's era dropdown lays
it over the shared BC/AD axis as a grouping **lens**: it renames the axis's
segments (e.g. "1st c. BC" → "共和政ローマ"), but it does **not** filter which
notes are shown — the same year read through the Japanese vs. Roman lens gives
different context, and cross-domain notes stay visible.

Systems live in `_chronology/eras.md`, one `##` per system. Each line under it
is a boundary: `<year> <name>`, where the year (bare = AD, or add `BC`) is where
that era begins; it runs until the next line. A system is therefore a clean
partition of the axis — no gaps, no overlaps:

```
## 日本史
710 奈良時代
794 平安時代
1185 鎌倉時代

## ローマ史
753 BC 王政ローマ
509 BC 共和政ローマ
27 BC ローマ帝国
```

Add and edit systems by hand, or open **Manage era systems** (button in the
timeline bar, or the command palette) for a page with a system list and an
editable boundary table, plus one-click import of bundled templates. A profile
can set `eraSystem: <name>` as its default lens; anything a system doesn't cover
falls back to its century heading.

## Filter, lens, views

The timeline's top bar is the pane's whole definition, in reading order:

- **Filter** — a query builder: type terms (keywords / tags / `OR` / `-not` /
  `"phrase"`) and press Enter to commit them as removable chips; the input's
  text also filters live. What you see in the box is exactly what filters the
  list — there is no hidden second layer.
- **Lens** — the era-system dropdown, visually separate because it never
  filters: it only renames the axis's segments. A **Group** dropdown picks the
  fallback granularity (century / decade / none) where no lens applies.
- **View** — a profile is a saved snapshot of the current filter + lens +
  grouping. Load one from the bookmark menu, tweak anything (a dot marks
  unsaved changes), then *Update*, *Save as new view…* or *Delete*. Views are
  stored in `_chronology/profiles.md` (plain text, hand-editable).

Each pane's state (filter, lens, grouping, loaded view, year-sync) persists
with the Obsidian workspace layout.

## Layouts

One timeline view can hold several **tracks** — columns inside the same tab,
each with its own filter and lens. The rows are shared time segments (century
or decade, via the Group control), so every column stays exactly year-aligned
under a single scrollbar; a track's own era names (its lens) appear as bands
inside its column. Add a column with the columns button in the bar; click a
column header to edit that track's filter/lens in the bar; hover a header for
its remove button.

A layout is a saved comparison grid: the view's tracks, as one named unit.
**Save layout…** snapshots the active timeline's tracks; **Open saved
layout…** opens a new timeline tab with the saved tracks. Both live in the
view (bookmark) menu and the command palette. Layouts are stored in
`_chronology/layouts.md` (plain text, hand-editable).

## Tracks

There are no preset tracks. A timeline is simply the result of a pane's
free-form filter combined with an era-system lens. `#histolog/<name>` is just
an ordinary tag you can write — including inside ev markers, any number of
them: `{ev k7f3a9x1 #ad/04/7/6 #histolog/ローマ史 #histolog/ヨーロッパ史 }` —
and then filter on (`#histolog/日本史` as a chip or in a saved view), exactly
like any other keyword.

Parallel comparison falls out naturally: run **Open another timeline (split
pane)** to open more timelines side by side, give each its own profile filter
and era system, and press each pane's link button to sync their scrolling
aligned by year.

## Data & privacy

- All data (`events.md` and future rules/profiles) lives in a folder inside your
  vault as plain markdown — hand-editable and sync-friendly.
- The plugin operates fully offline. No data leaves your vault.

## Development

```bash
npm install --legacy-peer-deps
npm run build     # tsc typecheck + esbuild bundle
npm run verify    # run the pure-logic checks
npm run dev       # watch build
```
