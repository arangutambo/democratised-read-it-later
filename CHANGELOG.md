# Changelog

## 0.1.0 — first release

Read a document inside Obsidian and choose what enters your vault.

**Reading and clipping**
- Reader's own pdf.js viewer: one page at a time under a memory budget, so a
  315-page workbook stays usable. Registers `.reader` rather than `.pdf`, so
  Obsidian's built-in PDF viewer is untouched.
- `q` quotes, `r` clips a region, `p` clips a page, `f` finds, `o` outlines.
- Quotes are rebuilt from text-layer geometry, and the layer is built in reading
  order, so a two-column page selects the sentence you pointed at rather than the
  figure caption beside it.
- Clips materialise into the vault. Highlights are stored as fractions of a page,
  so they hold at any zoom or window size, and deleting a bullet deletes the
  highlight — the note is the source of truth.
- `shift` makes a clip a parent; later clips nest under it, positionally.

**Sources**
- EPUB, one spine section at a time; a figure clip takes the publisher's own file.
- Saved web articles, with remote images blocked until you ask for them.
- YouTube transcripts as video-above-transcript, `f` capturing the exact frame.

**Library**
- A shelf with reading state, progress, filtering and fuzzy search; opens on what
  is in progress. Right-click to remove, always to trash and always after
  telling you how much of your own writing is at stake.

**Importers**
- Readwise, from the export files — no token, no subscription. Shows the plan
  before writing and is safe to re-run.
- Zotero and Apple Books highlight migration (desktop).

**Optional AI**
- `x` transcribes a clipped region to LaTeX or markdown. Off by default, needs
  your own key, and the result is always shown to you before anything is written.
