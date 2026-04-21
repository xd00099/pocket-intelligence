# Knowledge Base — LLM Operating Instructions

> **Copy this file to your vault root as `CLAUDE.md`.** The `ingest` skill reads it as the first step of every ingest to know how your vault is organized.

This Obsidian vault is an LLM-maintained knowledge base. The LLM writes and maintains all wiki content; you curate sources, direct analysis, and ask questions. The LLM handles summarizing, cross-referencing, filing, and bookkeeping. This schema is co-evolved between you and the LLM over time.

## Three Layers

**Raw sources** (`_raw/`) — Curated collection of source documents: articles, papers, images, data files. Immutable — the LLM reads from them but never modifies them. This is the source of truth.

**The wiki** (`<Topic>/wiki/`) — LLM-generated markdown files. Summaries, concept pages, entity pages, comparisons, syntheses. The LLM owns this layer entirely: creates pages, updates them when new sources arrive, maintains cross-references, keeps everything consistent. You read it; the LLM writes it.

**The schema** (`CLAUDE.md`) — This file. Tells the LLM how the wiki is structured, what conventions to follow, and what workflows to use. Co-evolved over time.

```
<vault>/
├── CLAUDE.md              # This file — the schema
├── index.md               # Master index of all knowledge areas (content-oriented)
├── log.md                 # Chronological record of all operations
├── _templates/            # Templates for new articles and topics
├── <Topic>/               # One directory per knowledge area
│   ├── index.md           # Topic index — every page listed with one-line summary
│   ├── wiki/              # Compiled wiki articles (the LLM's domain)
│   │   ├── concepts/      # Core concepts and theory
│   │   ├── algorithms/    # Algorithm deep-dives (domain-specific)
│   │   ├── applications/  # Real-world applications
│   │   ├── papers/        # Paper summaries and analyses
│   │   └── resources/     # Courses, books, tools, people
│   └── outputs/           # Visual artifacts only (slides, charts, diagrams)
└── _raw/                  # All raw source materials (immutable)
    └── <topic>/           # Papers, PDFs, clipped articles per topic
```

The wiki subdirectory structure (`concepts/`, `algorithms/`, etc.) is a suggestion, not a requirement. Pages can live anywhere under `wiki/`. Let the content dictate organization.

## Conventions

### File Naming
- Use `kebab-case.md` for all wiki files (e.g., `policy-gradient-methods.md`)
- Use `index.md` for directory index files

### Article Format
Every wiki article should have YAML frontmatter:

```yaml
---
title: Article Title
aliases: [alternate names for Obsidian linking]
tags: [topic/subtopic, type/concept]
sources:
  - "[[_raw/<topic>/source-file.pdf]]"
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
```

**Sources convention**: Use `[[wikilinks]]` to canonical raw files (PDFs, original clippings) so they're clickable in Obsidian. Never reference text extractions (`.txt`) or markdown conversions — those are processing artifacts, not sources. Use block YAML list format (not inline `[...]`) to avoid linter issues.

### Linking
- Use Obsidian `[[wikilinks]]` for internal links between articles
- Use `[[article-name|display text]]` when the link text should differ
- Every article should link to related concepts (backlinks)
- Every article should be reachable from its topic `index.md`

### Tags
Use hierarchical tags:
- `type/concept`, `type/algorithm`, `type/paper`, `type/resource`, `type/comparison`, `type/synthesis`
- `topic/<area>` — e.g., `topic/rl`, `topic/ai`, `topic/agents`
- `status/stub`, `status/draft`, `status/complete`

## Operations

### Ingest
Drop a new source into `_raw/` (or use the app's upload button — it lands the file in `_clippings/` and the `ingest` skill files it to the right place).

1. Read the source, discuss key takeaways
2. Write a summary page in the wiki (or update existing pages)
3. Update relevant concept/entity pages across the wiki — a single source might touch 10–15 pages
4. Update the topic `index.md` with any new pages
5. Append an entry to `log.md`

Prefer ingesting one source at a time with discussion, but batch-ingest is fine for large imports.

### Query
Ask questions against the wiki. The LLM:

1. Reads `index.md` of relevant topics to find pages
2. Reads the most relevant wiki articles
3. If the wiki is insufficient, reads raw sources
4. Synthesizes an answer

**Key insight: good answers should be filed back into the wiki as new pages.** A comparison, analysis, or connection that took work to produce shouldn't disappear into chat history. Explorations compound in the knowledge base just like ingested sources do. The `outputs/` directory is only for non-markdown visual artifacts (Marp slides, matplotlib charts). Text answers become wiki pages.

### Lint
Periodically health-check the wiki. Look for:

- Contradictions between pages
- Stale claims that newer sources have superseded
- Orphan pages with no inbound links
- Important concepts mentioned but lacking their own page (stubs)
- Missing cross-references between related pages
- Broken wikilinks

The LLM should also suggest: new questions to investigate, new sources to look for, connections between topics that haven't been articulated yet.

## Indexing and Logging

### `index.md` (content-oriented)
A catalog of everything in the wiki. Each page listed with a link and one-line summary, organized by category. The LLM updates it on every ingest. When answering a query, the LLM reads the index first to find relevant pages, then drills in. Works well at moderate scale (~100+ pages) without needing embedding-based RAG.

### `log.md` (reverse-chronological table)
A table tracking all operations, newest entries on top. Format:

```
| Date | Op | Source | Articles Created / Updated | Details |
```

- **Op**: `ingest`, `update`, `lint`, `query`
- **Articles Created / Updated**: must contain `[[wikilinks]]` to every wiki article touched
- **Details**: concise but specific — key topics, case studies, cross-links

The log gives a timeline of the wiki's evolution and is what the voice agent reads for "Daily Briefing" and "Podcast" modes.

## Adding a New Knowledge Area

1. Create `<Topic>/` directory with `index.md` and `wiki/` subdirectories
2. Add raw materials to `_raw/<topic>/`
3. Add the topic to the master `index.md`
4. Use `_templates/new-topic.md` as a starting point

## Obsidian Tips

- **Web Clipper** — Browser extension that converts web articles to markdown. A simple way to get sources into `_raw/`.
- **Download images locally** — In Settings → Files and links, set attachment folder to `_raw/assets/`. Lets the LLM reference images directly.
- **Graph view** — Best way to see the shape of the wiki: hubs, orphans, clusters.
- **Marp plugin** — Markdown-based slide decks, generated from wiki content into `outputs/`.
- **Dataview plugin** — Runs queries over page frontmatter. If wiki pages have YAML tags/dates/source counts, Dataview can generate dynamic tables and lists.
- The wiki is a git repo — version history, branching, and collaboration for free.

## Current Knowledge Areas

<!-- Fill this in as you bootstrap each knowledge area. Example:
- **RL** — Reinforcement Learning (raw: `_raw/RL/`)
- **Agents** — Agent harness design, tool architecture (raw: `_raw/agents/`)
-->
