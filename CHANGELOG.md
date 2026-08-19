# Changelog

## 0.4.0

**Captured frames are just the frame now.** Two things were getting into them.
Burned-in subtitles survived `cc_load_policy=0`, because that parameter only
sets a default and an account with "always show captions" overrides it — the
caption module is now unloaded outright, which the player cannot ignore. And a
paused embed draws its own furniture, the play button and link badge and "More
videos" strip, all of which `capturePage` photographed; a capture taken while
paused now briefly resumes, shoots, and pauses again. The video moves less than
half a second, well inside the gap between transcript paragraphs.

Screenshots added to the README, and a Buy Me a Coffee link.

## 0.3.0

**Save a YouTube video by pasting its link**
- *Save a YouTube video to Reader* fetches the transcript and writes it into your
  vault as a document you own — searchable, quotable, and yours after the video
  is taken down. It opens as the video above its transcript, so <kbd>f</kbd>
  captures the frame and <kbd>q</kbd> quotes the words, exactly as a Readwise
  video does.
- Written in the same per-phrase format as the Readwise export, so there is one
  kind of video document rather than two.
- Desktop only: the transcript is read from a real YouTube page in a webview, and
  there is no webview on mobile.
- Roughly two seconds a video. Timings are millisecond-accurate, which is finer
  than YouTube's own transcript panel shows.

**Fixed**
- Saving a page by URL now opens it *in Reader*. It was opening the raw `.html`
  file, because a document needs its `.reader` sidecar and note to be a document
  and 0.2.0 never created them. The URL is also recorded in the note's
  frontmatter now, which is where the reader looks to tell a video from an
  article.

## 0.2.0

**Save a page to Reader**
- Paste a URL and the article is written into your vault as a document you own:
  readable offline, greppable, and clipped with the same keys as everything
  else. Sanitised before it is written, not when it is read, so third-party
  HTML never reaches disk in its raw form.
- Only `http` and `https` are accepted — inside Electron a `file:` or `app:`
  URL reaches the filesystem, and that string arrives from a paste box.
- A page that comes back with no readable text fails loudly rather than saving
  an empty document.

**Fixed**
- <kbd>f</kbd> opens find again in PDFs, EPUBs and articles. It had been
  shadowed by the video frame capture added in 0.1.0 — two `case "f"` clauses,
  the second unreachable — so outside a video the key did nothing at all.

**Renamed**
- The plugin is now *Democratised Read It Later*, id
  `democratised-read-it-later`. A vault carrying the old `reader` folder should
  delete it once this version is enabled, or the two will both load.

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
