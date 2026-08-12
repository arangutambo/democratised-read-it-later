# Reader

A read-it-later, reader-mode, highlighting and research-capture system for Obsidian, with a
Safari extension to follow. Reading, annotating and citing are meant to be the same act, over
plain files you own.

**Status: M2.** Apple Books highlights import into notes carrying a citekey, CSL frontmatter
and a managed highlights region, and the reader skin renders them. 143 tests, no browser.

### Apple Books requires Full Disk Access

`~/Library/Containers/com.apple.iBooksX/` is TCC-protected, so **Obsidian must be granted
Full Disk Access** before the import can read it: System Settings → Privacy & Security →
Full Disk Access → add Obsidian → quit and reopen Obsidian.

Without it the read does not fail cleanly — measured, it never returns at all. Every call
against the Books databases is therefore wrapped in a timeout and reports the fix above
rather than hanging Obsidian.

- [`DESIGN.md`](DESIGN.md) — the original design interrogation. Statement of intent.
- [`PLAN.md`](PLAN.md) — what actually gets built, in what order. **Supersedes `DESIGN.md`
  where they conflict**, and opens with five corrections the design got wrong.

## Development

```bash
npm install
npm run dev            # watch build, straight into the vault, Hot Reload picks it up
npm test               # 143 tests, no browser required
npm run books:dry-run  # run the Books pipeline on real data, writing nothing
npm run build          # typecheck + production build into the repo
npm run install-local  # production build, copied into the vault
```

`npm run dev` writes `main.js`, `styles.css`, `manifest.json` and a `.hotreload` marker into
`$OBSIDIAN_VAULT/.obsidian/plugins/reader/`. Set `OBSIDIAN_VAULT` to override the default
vault path. Install [Hot Reload](https://github.com/pjeby/hot-reload) for the reload loop —
it watches `main.js` and `styles.css` in any plugin directory containing `.hotreload` or
`.git`.

## The one structural rule

**Nothing under `src/core/`, `src/anchor/`, `src/template/`, `src/transport/` or
`src/sources/*/map.ts` may import from `obsidian`.**

Those layers stay pure so they can be unit-tested in plain Node — which is what makes the
highlight re-anchoring engine, the riskiest code in the project, testable at all. Only
`main.ts`, `settings/tab.ts`, `render/`, `review/` and `sources/*/db.ts` touch the Obsidian
API. `test/architecture.test.ts` enforces this; it is not a convention to remember.

## Performance discipline

Every listener, observer, interval and iframe registers with `src/core/disposables.ts`, and
`onunload()` drains it. `test/main.test.ts` asserts the registry is empty after unload. This
is not boilerplate — it is the specific guard against the runaway-JS failures documented in
`PLAN.md` §6.

## Licence

MIT.
