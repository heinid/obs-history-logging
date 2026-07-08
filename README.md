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

## Tracks

`#histolog/<track>` tags classify entries into *tracks* (datasets/columns —
日本史, 中国史, 科学史…), the filtering dimension, orthogonal to the era-system
lens. A track tag inside a dated block classifies that block; a track tag
standing alone (in a block with no year tag, e.g. a `#histolog/日本史` line at
the top of a note) is the file-wide default for blocks with no track of their
own. Entries without any track are "No track".

When the vault has tracks, the timeline shows a row of toggle pills under the
top bar — switch tracks off/on to filter which entries are shown. Cards carry a
small badge naming their track(s).

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
