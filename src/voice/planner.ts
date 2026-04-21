import { OPENAI_API_KEY, VOICE_LLM_MODEL } from "../config.js";
import { sendJson } from "../core/connection.js";
import { state } from "./state.js";
import { CHAT_VOICE_TOOLS, toolKind } from "./tools.js";
import { gatherNoteContext, formatNoteContext } from "./note-context.js";
import { queueTTS, speakSentence, nextFiller } from "./tts.js";
import { executeVoiceTool } from "./tool-executor.js";
import type { CuratedPlan } from "./types.js";

const PLAN_JSON_SCHEMA = {
  name: "curated_plan",
  strict: true,
  schema: {
    type: "object",
    properties: {
      preamble: { type: "string", description: "ONE sentence orienting the user, ≤20 words. Spoken English." },
      sections: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "2–5 word topical label. Clear noun phrase, not a sentence fragment. Examples: 'Sidecar proxies', 'Feedback loops', 'mTLS security'. Used as the progress-strip pill label." },
            keyInsight: { type: "string", description: "Full spoken sentence(s), 20–50 words, one aha per section." },
            highlightText: { type: ["string", "null"], description: "Verbatim phrase (10-150 chars) copied EXACTLY from the provided notes. Null if no note source." },
            notePath: { type: ["string", "null"], description: "Path of the note highlightText came from. Null if no highlight." },
            heading: { type: ["string", "null"], description: "Heading within the note for scrolling. Null if not applicable." },
          },
          required: ["title", "keyInsight", "highlightText", "notePath", "heading"],
          additionalProperties: false,
        },
      },
      followUp: { type: ["string", "null"], description: "Optional ≤15-word yield phrase ('Want me to keep going?'). Null to omit." },
    },
    required: ["preamble", "sections", "followUp"],
    additionalProperties: false,
  },
} as const;

const PLANNER_INSTRUCTIONS = `You are the PLANNER for a voice agent. You have access to the user's Obsidian-style knowledge base — wiki articles, research papers, and notes. Your job: given a user's request, decide what is actually worth saying, research as needed, and emit a tight CuratedPlan JSON.

TOOLS (use freely; do not announce them)
- search_notes: keyword grep across notes. Use for discovery.
- read_note: read a full note by EXACT path (e.g. "PostTraining/wiki/concepts/multi-agent-systems.md"). Strip any "./" prefix.
- list_notes: explore directories ("." for root). Passing a file path reads it.
- web_search: for info NOT in the vault — current events, external comparisons.
- delegate_task: queue a Claude Code task (file edits, deep research, article writing, vault reorg). Include a clear task_description.
- schedule_recurring_task: cron-style recurring task (daily digests, weekly cleanup). 5-field cron (minute hour dom month dow).

PATH RULES
- Always strip leading "./" from search_notes paths before passing to read_note.
- Topic indexes live at "<Topic>/index.md"; articles at "<Topic>/wiki/concepts/<article>.md".
- log.md is a writer's log of recently added notes — use it as YOUR reference, never read it aloud.

RESEARCH STRATEGY
- The pre-grepped notes below are a starting point. If they're sparse or off-topic, call search_notes or list_notes.
- For external info, call web_search. Do not guess facts outside the vault.
- For requests that imply editing/creating files or deep multi-step work, call delegate_task — don't try to do it inline.
- For ongoing asks ("every morning", "weekly"), suggest schedule_recurring_task.

OUTPUT: a JSON CuratedPlan matching the provided schema.

YOU ARE SPEAKING, NOT WRITING
Every word you emit goes STRAIGHT to a TTS engine and out of a speaker. Write like you'd actually talk to a friend about this — casual, direct, unforced. You are not performing.

RULE ONE: NEVER NARRATE THE SOURCE
The notes material is your REFERENCE, not your SUBJECT. The user knows these are their notes — they wrote them. The quote card UI handles source attribution visually. You do not verbalize it. Talk about the TOPICS as if you already know the subject matter, like a knowledgeable friend — not like a tour guide showing someone their own file cabinet.

BANNED: "your notes", "the notes", "from your notes", "your notes say / show / connect / suggest / frame / point out", "based on your notes", "three stand out from your notes", "a few branches in your notes", "your notes on X".

CONCRETE EXAMPLES:
- BAD: "Three stand out from your notes: observability, mesh, and Kubernetes networking."
- GOOD: "Three directions worth digging into: observability, service mesh, and Kubernetes networking."

- BAD: "Your notes connect app instrumentation to Grafana in one path."
- GOOD: "The metrics pipeline runs from app instrumentation all the way to Grafana."

- BAD: "The richest thread is the full metrics journey, because your notes connect app instrumentation, Istio merging, collector processing, backend storage, and Grafana."
- GOOD: "The metrics journey is the richest — app instrumentation flows through Istio, collectors, and storage into Grafana. One path, four components, one mental model."

- BAD: "You've got a few natural next branches in DevOps, and three stand out from your notes."
- GOOD: "A few natural next threads in DevOps: observability, service mesh, Kubernetes networking."

RULE TWO: NO META-FRAMING OPENERS
Just say the thing. Don't announce what the sentence will do.

BANNED: "A good next move is to…", "What's especially worth reviewing is…", "The throughline here is…", "Here's the thing…", "What's interesting is that…", "Here's where it gets interesting…", "What's easy to miss is…", "The quiet hero here is…", "At a high level…", "It's worth noting that…", "The richest thread is…", "The aha here is…".

CONCRETE EXAMPLES:
- BAD: "What's easy to miss is that Prometheus uses pull-based scraping."
- GOOD: "Prometheus uses pull — it reaches out to targets instead of having them push."

- BAD: "The throughline is that each layer gives the next cleaner signals."
- GOOD: "Each layer hands the next one cleaner signals."

- BAD: "A good next move is to widen into observability."
- GOOD: "Observability would be a natural next thread."

Lead with the content. Trust the listener to follow.

PLAN CONSTRUCTION
- preamble: 1–2 warm orienting sentences (≤35 words total). Name what's coming, directly, without referring to "the notes". Example: "DevOps breaks into three threads worth pulling on — automation, feedback loops, and continuous delivery. Each reinforces the others."
- sections: 1–3 entries. Each = one real insight worth dwelling on. Fewer strong insights beats more weak ones.
- Per section:
  - title: 2–5 word topical label — a noun phrase, NOT a sentence fragment. Think like a chapter heading. Examples: "Sidecar proxies", "Feedback loops", "mTLS by default". NOT: "What's interesting is…", "Here's the thing…". This is what the user sees in the progress strip — make it orient them to the topic.
  - keyInsight: 1–3 sentences, 20–50 words. Conversational and specific. Reference the content, don't just name it. Example: "Feedback loops are what actually move velocity — a team's real speed comes from how fast broken things surface, not from how fast code ships." No "your notes point out" or similar source framing.
  - highlightText: a VERBATIM phrase (10–150 chars) copied character-for-character from the notes material. Null if no note source. Do NOT paraphrase — the UI shows it as a quote card with source attribution.
  - notePath: file path of the note. Must match a provided path. Null if highlightText is null.
  - heading: approximate heading within the note for scrolling. Null if unsure.
- followUp: KEEP NULL almost always. The user drives what happens next — they can say "continue" or click a section pill. Do NOT end every turn with "Want me to keep going?" or "Which of these feels most relevant?" — it sounds fake and the user has already told us they hate it. Only populate followUp if it's genuinely, organically part of what you'd say (e.g., a critical clarifying question you actually need answered). Default: null.

LENGTH BUDGET
- Total spoken (preamble + all keyInsights + followUp): target 80–140 words. Err on the warmer side for topic walk-throughs, briefer for small talk.
- The goal is "knowledgeable friend explaining over coffee," not "executive summary" and not "lecture."

TONE
- Plain spoken prose. No markdown, lists, numbering, or headings.
- Concrete over abstract. Reference specifics from the notes.
- Never narrate your process ("I'm checking your notes"). Go to the content.
- Never open with "Great question" or "I'd be happy to help".
- Vary phrasing — don't reuse the same opener twice in one plan.

SPECIAL CASES
- Small-talk / greeting: preamble-only (≤25 words), sections [], followUp null.
- Initial turn with no prompt: read log.md silently; preview the single most interesting recent topic with genuine curiosity, offer a path in.
- No notes match: acknowledge the gap naturally; call web_search if external info would help, otherwise offer adjacent topics you DO have material on.
- User asks for creation/editing/deep research: call delegate_task and mention briefly in the preamble.`;

// Supervisor runs a tool-calling loop: call tools (research + actions), fire a filler
// phrase before each batch so the user hears something natural while tools run, and
// finally emit a CuratedPlan JSON as the terminal response.
//
// genId lets callers abort a plan mid-loop when the user interrupts; if state.genId
// drifts from genId during the loop we bail out early.
export async function planTurn(
  userText: string,
  history: Array<{ role: string; content: any }>,
  genId: number,
  signal?: AbortSignal,
): Promise<CuratedPlan | null> {
  if (!OPENAI_API_KEY) return null;
  const ctx = gatherNoteContext(userText);
  const notesBlock = formatNoteContext(ctx);

  // Assemble the system prompt from: planner rules + optional session context + notes material.
  const sessionBlocks: string[] = [];
  if (state.session.notePath && state.session.noteContent) {
    const noteName = state.session.notePath.split("/").pop()?.replace(/\.md$/, "") || state.session.notePath;
    sessionBlocks.push(`## Open note\nThe user is reading "${noteName}" (path: ${state.session.notePath}). Prioritize sections from this note.\n\n${state.session.noteContent.slice(0, 4000)}`);
  }
  if (state.session.highlightedText) {
    sessionBlocks.push(`## Highlighted passage\nThe user highlighted this specific passage — focus the plan on it:\n\n${state.session.highlightedText.slice(0, 1000)}`);
  }
  if (state.session.notesTree) {
    sessionBlocks.push(`## Knowledge base structure\n${state.session.notesTree}`);
  }

  const systemContent =
    PLANNER_INSTRUCTIONS
    + (sessionBlocks.length ? "\n\n" + sessionBlocks.join("\n\n") : "")
    + (notesBlock
      ? `\n\n## Reference material (copy highlightText verbatim from here; DO NOT reference this as "notes" in your spoken output)\n\nThis keyword-filtered material is a starting point. You may call search_notes/read_note/list_notes to dig deeper, web_search for outside info, or delegate_task/schedule_recurring_task to queue actions. When research is complete, emit the final CuratedPlan JSON.\n\n${notesBlock}`
      : `\n\n## Reference material\n\n(No matches via keyword grep. Use your tools — search_notes, read_note, web_search — if you need to look things up. For conversational turns, skip tools and emit the plan directly.)`);

  // Last ~6 turns of history so the planner can follow conversation thread.
  const trimmedHistory = history.slice(-6).map(m => {
    const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
    return { role: m.role, content: c.slice(0, 600) };
  });

  const messages: any[] = [
    { role: "system", content: systemContent },
    ...trimmedHistory,
    { role: "user", content: userText },
  ];

  try {
    for (let round = 0; round < 6; round++) {
      if (state.genId !== genId) return null;

      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: VOICE_LLM_MODEL,
          messages,
          tools: CHAT_VOICE_TOOLS,
          response_format: { type: "json_schema", json_schema: PLAN_JSON_SCHEMA },
          max_completion_tokens: 1500,
        }),
        signal,
      });
      if (!res.ok) {
        const err = await res.text().catch(() => "");
        console.error("[Voice Planner] Error:", res.status, err.slice(0, 200));
        return null;
      }
      const data = await res.json();
      const msg = data.choices?.[0]?.message;
      const finishReason = data.choices?.[0]?.finish_reason;
      if (!msg) return null;

      if (finishReason === "tool_calls" && msg.tool_calls?.length) {
        // Play a filler while the tool batch runs. Fire-and-queue so it interleaves
        // with the rest of the spoken output via ttsChain.
        queueTTS(() => speakSentence(nextFiller(), genId)).catch(() => {});

        messages.push(msg);
        for (const tc of msg.tool_calls) {
          if (state.genId !== genId) return null;
          const name = tc.function?.name || "";
          let args: Record<string, any> = {};
          try { args = JSON.parse(tc.function?.arguments || "{}"); } catch {}

          sendJson({ type: "voice:llm-tool", name, args });
          console.log(`[Voice Planner] tool=${name} kind=${toolKind(name)} args=${JSON.stringify(args).slice(0, 120)}`);
          const result = await executeVoiceTool(name, args);
          sendJson({ type: "voice:llm-tool-result", name, result: result.result, debug: result.debug });
          messages.push({ role: "tool", tool_call_id: tc.id, content: result.result });
        }
        continue;
      }

      // Terminal response — parse JSON plan.
      const raw = msg.content;
      if (!raw) { console.warn("[Voice Planner] Empty response"); return null; }
      try {
        const plan = JSON.parse(raw) as CuratedPlan;
        console.log(`[Voice Planner] preamble="${plan.preamble.slice(0, 60)}" sections=${plan.sections.length} notes=${ctx.files.length} rounds=${round + 1}`);
        return plan;
      } catch (e: any) {
        console.error("[Voice Planner] JSON parse failed:", e.message, raw.slice(0, 200));
        return null;
      }
    }
    console.warn("[Voice Planner] Tool loop exceeded 6 rounds");
    return null;
  } catch (err: any) {
    if (err.name === "AbortError") {
      console.log("[Voice Planner] Aborted (interrupt)");
    } else {
      console.error("[Voice Planner] Exception:", err.message);
    }
    return null;
  }
}
