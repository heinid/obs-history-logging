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
