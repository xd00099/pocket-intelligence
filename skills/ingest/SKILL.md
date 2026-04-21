---
name: ingest
description: Process new clippings into the knowledge base — file raw sources, write/update wiki articles, cross-link, update indexes, log. Falls back to a health check when _clippings/ is empty.
---

# Ingest

Process new sources into the wiki, or health-check the vault if nothing is new.

**First**: read `CLAUDE.md` at the vault root — it defines the three-layer architecture, all conventions, and the four operations.

## Judgment Calls

The hard part of knowledge base maintenance isn't the procedure — it's these recurring decisions:

**Create a new page or update an existing one?**
- A concept mentioned in passing in 1–2 articles → add to the most relevant existing page.
- A concept with its own definitions, examples, and connections → it deserves a dedicated page. Rule of thumb: if you'd need to link to it from 3+ places, make a page.
- When in doubt, create. A thin page that gets filled in later is better than a scattered concept.

**How deep should an article go?**
- Deep enough to be useful as a reference without re-reading the source. A reader should be able to understand the concept and how it connects to the rest of the KB from the wiki article alone.
- Include specific numbers for papers (FID scores, accuracy, speedups). Include concrete examples for concepts. Tables for comparisons.

**What if a new source contradicts an existing article?**
- Update the article to reflect the current understanding. Don't just overwrite — show the evolution if the shift is significant ("Earlier work suggested X, but Y (2025) demonstrates Z").
- If the disagreement is unresolved, present both views.

**What if a source doesn't fit anywhere?**
- If it's tangential but interesting, file in `raw/` under the closest topic and note it in Stubs & Gaps. Not everything needs a wiki page immediately.

## Phase 1 — Discover

1. List `_clippings/`. If files exist, proceed to Phase 2.
2. If `_clippings/` is empty, skip to Phase 6 (health check).
3. **One at a time by default.** Read each source, discuss key takeaways with the user, then process. Batch-ingest is fine when the user explicitly asks for it or drops a large import.

## Phase 2 — Assess & File

For each clipping:

1. **Read it fully.** Understand what it covers — key ideas, how it connects to existing wiki content.
2. **Identify the target knowledge area.** Read the master `index.md` and relevant `<Topic>/index.md` to see what exists. If the source spans multiple areas, pick the primary home and note cross-links for later.
3. **Create a new knowledge area if needed** — directory structure, index from `_templates/new-topic.md`, entries in master `index.md` and `CLAUDE.md`.
4. **Copy the clipping** to `raw/<topic>/`, keeping its original filename. Do NOT delete from `_clippings/` yet — that happens in Phase 5 after everything succeeds.

### Handling different source types

| Type | How to process |
|------|---------------|
| **Markdown** (Web Clipper) | Read directly. Frontmatter has the source URL. |
| **PDF** | Extract text with `pdftotext <file>.pdf <file>.txt` (or `python3 -m pdfminer.six`). Read the PDF directly for visual content (figures, tables, diagrams). The `.txt` is a processing aid — the `.pdf` is the canonical source referenced in frontmatter. |
| **Image** | Read the image directly. File in `raw/assets/` or alongside related sources. |
| **External link** (Google Slides, Docs) | Try to export as PDF first (`/export/pdf` URL suffix). Save PDF to `raw/`, extract text. If export fails, note it and ask the user to download manually. |

## Phase 3 — Write Wiki Articles

A single source may create new articles AND update existing ones. A paper might produce its own summary page plus updates to 5–10 concept pages.

### Creating new articles

- Use `_templates/new-article.md` as a starting point. File naming: `kebab-case.md`.
- **Required structure**: YAML frontmatter → `# Title` → `> blockquote summary` → content sections → `## Connections` → `## References`.
- **Concept pages**: explain ideas in the author's framing, use tables for comparisons, include concrete examples. Self-contained — a reader shouldn't need the source to understand the page.
- **Paper pages**: lead with `**Authors:** / **Year:** / **Venue:**`, then Summary → Key Contributions (with specific numbers) → Connections → References.
- **Aliases**: add every name, abbreviation, and key term the concept is known by (e.g., `aliases: [RLHF, RL from Human Feedback, InstructGPT, alignment]`). Good aliases make Obsidian's graph and search work. Include the acronym AND the expansion.
- **Status tags**: mark `status/complete` when the article covers the source material comprehensively with connections. Mark `status/draft` only if you know important content is missing and plan to return.

### Updating existing articles

When new information supplements an existing page:
- Add the new source to the `sources:` frontmatter list.
- Update the `updated:` date.
- Integrate new content into the existing structure — don't just append. The article should read as if it was always there.
- If the update is substantial, mention it in the log details.

### Noting stubs

When a source references important concepts that deserve their own page but aren't worth creating right now, add them to the topic's **Stubs & Gaps** section in `index.md`. Include what source mentions them and roughly what's needed.

### Frontmatter rules

```yaml
sources:
  - "[[raw/<topic>/source-file.pdf]]"
```

- **Always reference the canonical raw file** (PDF, original clipping) — never `.txt` extractions or `.md` conversions.
- **Use block YAML list format** (not inline `[...]`) to avoid Obsidian linter corruption.
- Sources must be `[[wikilinks]]` so they're clickable in Obsidian.

## Phase 4 — Cross-Link & Index

Do these together since they're intertwined:

1. **Add a `## Connections` section** to each new article with `[[wikilinks]]` to related pages across ALL knowledge areas. Each link must explain *why* it connects — not just `[[ppo]]` but `[[ppo]] — the algorithm DPO was designed to replace`.
2. **Add backlinks** from existing articles to the new ones where relevant.
3. **Update the topic `index.md`** — add new pages to the table with one-line summaries, update the raw sources inventory, revise Stubs & Gaps. Update its `updated:` date.
4. **Update the master `index.md`** — page counts for affected topics. Update its `updated:` date.
5. **Update cross-topic link sections** in topic indexes if new connections were made.

## Phase 5 — Log & Clean Up

1. **Add a row to the TOP of the table in `log.md`** (newest first):

```
| Date | Op | Source | Articles Created / Updated | Details |
```

- `Articles Created / Updated` must have `[[wikilinks]]` to every article touched.
- Keep details concise but specific.

2. **Delete the clipping from `_clippings/`**. Only now — after raw is filed, wiki is written, indexes are updated, and log is recorded.

3. **Quick integrity check**:
   - Do the topic index page counts match reality? (`find <Topic>/wiki -name "*.md" | wc -l`)
   - Do the new articles' `sources:` point to files that actually exist?
   - Do new wikilinks resolve? (spot-check, not exhaustive)

## Phase 6 — Health Check (when _clippings/ is empty)

If there's nothing to ingest, audit the vault for drift:

### Structural checks

| Check | How |
|-------|-----|
| **Unindexed raw files** | Compare `raw/<topic>/` contents against wiki articles' `sources:` fields |
| **Stale page counts** | Count `.md` files in each `wiki/` and compare to master `index.md` |
| **Broken wikilinks** | Grep for `[[` targets and verify each resolves to a file |
| **Sources hygiene** | Grep for `sources:.*\.txt` or `sources:.*https://` in wiki files |
| **Orphan pages** | Find wiki `.md` files not referenced by any wikilink or index |
| **Log format** | Verify newest-first ordering, all rows have `[[wikilinks]]` |
| **Property types** | Check `.obsidian/types.json` — `sources` should be `multitext` |

### Content checks

| Check | How |
|-------|-----|
| **Stub promotion** | Review each topic's Stubs & Gaps — any stubs now have enough sources/mentions to warrant a page? |
| **Stale claims** | Skim recent articles — do any reference findings that newer sources in `raw/` have superseded? |
| **Duplicate concepts** | Look for two pages covering the same idea from different angles that should be merged |
| **Missing cross-links** | Read topic indexes side by side — are there obvious connections not yet in Cross-Topic Links? |

Report what's found. Fix what's fixable. Note remaining issues in topic indexes.

If everything is clean, report that the knowledge base is up to date.
