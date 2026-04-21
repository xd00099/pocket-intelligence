# Pocket Intelligence

> A note-taking app where every feature is LLM-native.
> Obsidian-compatible vault + voice agent + task delegation + git sync + diff review — all in one tab.

Inspired by Andrej Karpathy's tweet on LLM knowledge bases. Built because I couldn't find a single tool that unified Obsidian, ChatGPT, Claude Code, and GitHub into one workflow.

## Deploy your own

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https%3A%2F%2Fgithub.com%2Fxd00099%2Fpocket-intelligence)

Clicking the button provisions a Railway service running this repo's `Dockerfile`. You'll be prompted for the environment variables below before it boots.

## Demos

### Git-backed editing with diff review
<video src="https://github.com/user-attachments/assets/f7965c05-419b-4183-a4f2-da39e30c9e63" controls width="800"></video>

Create a note, see every edit land in a GitHub-style diff view, revert per file or push to your vault — all from the browser.

### Voice Q&A grounded in your notes
<video src="https://github.com/user-attachments/assets/f6ebdfbe-5e92-4ad3-b563-bed989240a59" controls width="800"></video>

"What's actor-critic in RL?" — the voice agent searches your vault, makes a couple of tool calls to pull the relevant passages, then explains it back with clickable quote cards that jump to source.

### Podcast mode for the commute
<video src="https://github.com/user-attachments/assets/a903c5fd-62a6-466b-8ea6-93598586af57" controls width="800"></video>

The voice agent reads your `log.md`, finds recently ingested topics, and synthesizes a podcast-style walk-through. Earbuds in, 20 minutes of review during the commute.

### Automated knowledge ingest
<video src="https://github.com/user-attachments/assets/7a18df0d-f3da-4447-ae89-87f8b307cafa" controls width="800"></video>

Drop a paper into the uploader. A Claude Code skill parses it, writes a summary note, and files it in the right folder of your vault — no manual organizing. You can also just ask the voice agent to research a topic online and ingest the findings.

### Knowledge graph
<video src="https://github.com/user-attachments/assets/a26dcf18-248d-4a68-82f7-22204d60683a" controls width="800"></video>

Neo4j-style force-directed view of every note + every wiki-link between them. See where your thinking is dense vs thin, and spot islands worth connecting.

## Features

- **Obsidian-compatible vault** — markdown, wiki-links, backlinks, tags, callouts. Your notes are plain files in a git repo.
- **Git sync** — point at any git repo, vault syncs across every device. GitHub-style diff review before anything writes back.
- **Intelligent sidebar** — `Cmd-K` to search, ask questions, run commands. Answers are grounded in your notes via grep retrieval.
- **Voice agent** — planner + OpenAI TTS. Walks you through recent notes podcast-style, answers with cited quote cards, handles interrupts. Karaoke transcript syncs words to audio playback.
- **Task delegation + cron** — voice agent or command bar can queue Claude Code tasks ("rewrite my Kubernetes notes with the latest mTLS guidance") and schedule recurring work (daily digests, weekly cleanup).
- **Knowledge ingest** — drop a PDF / DOCX / URL into the uploader; a Claude Code skill parses, summarizes, and files it into the right folder.
- **Knowledge graph** — Neo4j-style force-directed view of every note + every wiki-link. Click a node to jump to the source.
- **Embedded Claude Code terminal** — xterm.js piped through a server-side pty. Auto-approves tool permissions so work runs without interruption.

## Environment variables

See [`.env.example`](./.env.example) for the full list with inline documentation. The short version:

| Variable | Required | Purpose |
|---|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Yes | Google OAuth |
| `ALLOWED_EMAIL` | Yes | Only this email can sign in |
| `ANTHROPIC_API_KEY` | Yes | Claude Code + text chat |
| `OPENAI_API_KEY` | Yes | STT + planner + TTS |
| `NOTES_REPO` | No | Git repo containing your vault |
| `GITHUB_TOKEN` | No | Credential for pushing to `NOTES_REPO` |

Single-user by design — `ALLOWED_EMAIL` is the only account that can sign in. Multi-tenant is not supported.

## Local development

```bash
# 1. Clone + install
git clone https://github.com/USER/REPO.git
cd REPO
npm install

# 2. Configure env
cp .env.example .env
# then edit .env with your credentials

# 3. Dev server with hot reload
npm run dev
# → http://localhost:3000
```

Prerequisites:

- Node 20+
- `@anthropic-ai/claude-code` installed globally: `npm install -g @anthropic-ai/claude-code`
- `git`, `grep`, `find` available on `PATH` (standard on macOS / Linux)
- Optional: `libreoffice` for in-browser PPTX/DOCX previews
- Optional: `poppler-utils` for PDF asset handling

Production build:

```bash
npm run build      # compiles TypeScript to dist/
npm start          # runs the compiled server
```

## Architecture

```
Browser (public/js/*)
  ├─ Voice pipeline       — mic capture → WS → server → STT → planner → TTS → audio playback + karaoke
  ├─ Notes browser        — tree, markdown rendering, tabs, TOC, inline edit, diff review
  ├─ Command bar          — Cmd-K, grounded Q&A, /commands, graph search
  ├─ Knowledge graph      — Neo4j-style force-directed canvas
  ├─ Tasks                — queued + running + history of Claude Code tasks, cron jobs
  └─ Terminal             — xterm.js embedded in the intel panel

Server (src/*)
  ├─ voice/               — STT WebSocket, TTS streaming, planner (GPT-5.4 + tool loop), session orchestration
  ├─ routes/              — /api/notes/*, /api/chat, /api/tasks, /api/cron
  ├─ pty.ts               — Claude Code pty + auto-onboarding
  ├─ ws-handler.ts        — WebSocket upgrade, message dispatch, fs watcher
  ├─ auth.ts              — Google OAuth + session cookies
  └─ task-events.ts       — task queue worker + cron scheduler wiring

Storage (mounted volume)
  └─ WORKSPACE_DIR
      ├─ notes/            — your vault (git-backed if NOTES_REPO is set)
      ├─ .home/            — Claude Code config + sessions
      ├─ .sessions.json    — logged-in session cookies
      ├─ .task-queue.json  — queued + completed tasks
      └─ .cron-jobs.json   — scheduled recurring work
```

Single Node process. No database — everything is plain files on a mounted volume.

## Google OAuth setup

1. Go to <https://console.cloud.google.com/apis/credentials>.
2. Create an OAuth 2.0 Client (type: Web application).
3. Under **Authorized redirect URIs**, add:
   - `https://<your-railway-domain>/auth/callback` (production)
   - `http://localhost:3000/auth/callback` (local dev)
4. Copy the Client ID + Client Secret into `.env`.
5. Set `ALLOWED_EMAIL` to the Google account you'll log in with.

## Git-synced vault

Create a private GitHub repo for your vault (or point at an existing Obsidian vault repo). Generate a personal access token with `repo` scope. Set:

```env
NOTES_REPO=https://github.com/you/your-vault.git
GITHUB_TOKEN=ghp_...
GIT_USER_NAME=Your Name
GIT_USER_EMAIL=you@example.com
```

On boot, the server clones the repo to `$WORKSPACE_DIR/notes`, auto-pulls every 5 min, and the diff review UI lets you commit + push from the browser.

## License

[MIT](./LICENSE)
