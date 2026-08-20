# Changelog

## 0.7.0

The second round of community-review findings, and the tests that keep them
fixed.

**Node builtins are reached through a desktop guard.** Every
`import … from "node:fs"` in the plugin is now a `require()` behind a
`Platform.isDesktopApp` check, which is exactly what the review asked for. The
importers that use them — Apple Books, Zotero, and reading a file from outside
the vault — were already desktop-only and loaded lazily; the difference is that
the code says so now instead of a comment saying so. Loading one on mobile
raises a sentence you can act on rather than failing somewhere downstream.

Two architecture tests hold the line: no static `node:` import may return, and
the existing rule against *dynamic* `import("node:…")` — which Obsidian's
`app://` origin turns into a CORS failure — now understands that
`typeof import("node:fs")` is a type, erased before anything runs.

**Documented what the clipboard read actually does.** Opening *Save a page to
Reader* reads the clipboard once. It is used only if it is an `http(s)` URL and
you have not typed anything; anything else is dropped on the spot, never stored,
never written to disk, never sent anywhere.

**A test that the dev tools stay out of the plugin.** `tools/` holds Node
dry-run harnesses that import `node:fs` freely, which is correct because they
only ever run under Node — and nothing in `src/` reaches them, so none of it is
bundled. That is now asserted rather than assumed.

## 0.6.0

**Renamed to YouTube, EPUB and PDF Viewer and Note Taker.** The name now says
what the plugin does rather than what it was reacting to.

Only the display name changed. The plugin id stays `democratised-read-it-later`,
which is the folder your install lives in and the key your settings are stored
under — so this is an update, not a second plugin, and nothing needs moving.
You may need to reload Obsidian before the new name appears in the plugin list.

## 0.5.0

Everything the Obsidian community review raised, and the linter that would have
caught it in the first place.

**Requires Obsidian 1.13.** The settings tab now uses the declarative API, which
is what makes each setting findable from the settings search box rather than
only by scrolling this plugin's tab.

**Fixed**
- Page aspect ratios are set through `setCssStyles` rather than by assigning to
  `element.style`.
- The plugin description no longer says "Obsidian" — redundant inside a
  directory of Obsidian plugins.
- The confirm button on a destructive action uses `setDestructive()`, and the
  settings tab refreshes with `update()`; both replace APIs deprecated in 1.13.
- A byte-order mark sitting literally inside two regular expressions is written
  as `\uFEFF`, and the filename control-character class is spelled out instead
  of pasted in. Both were invisible in a diff.
- Values from frontmatter, templates and the metadata cache go through one safe
  stringifier, so an object can no longer reach a note as `[object Object]`.
- Timers use `window.setTimeout`, which is what a popout window needs.
- Several untyped reads (`any` from the metadata cache, `JSON.parse` of a
  cross-origin message, `new Map()` inferring `Map<any, any>`) are narrowed and
  checked rather than asserted.
- `builtin-modules` is gone; Node has shipped `module.builtinModules` for years.

**Added**
- ESLint, with `eslint-plugin-obsidianmd` and type-aware TypeScript rules, run
  by `npm run lint`. The repo had no linter, which is why the review found what
  it found; it now reports zero problems.
- A release workflow that builds on CI and publishes
  [artifact attestations](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds),
  so the released `main.js` can be cryptographically traced to this commit. It
  also refuses to publish when the tag and `manifest.json` disagree.

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
