// Voice tool definitions surfaced to the planner. Chat Completions needs each tool
// wrapped as { type: "function", function: {...} } — see CHAT_VOICE_TOOLS below.

export const VOICE_TOOLS = [
  {
    type: "function" as const,
    name: "search_notes",
    description: "Full-text search across all markdown notes in the knowledge base. Returns matching file paths (usable directly with read_note) and surrounding context snippets. Always use the exact file paths returned in results when calling read_note.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term or phrase to grep for across all .md files" }
      },
      required: ["query"]
    }
  },
  {
    type: "function" as const,
    name: "read_note",
    description: "Read the full contents of a specific note file. IMPORTANT: Use the exact path from search_notes results or list_notes results. Paths are relative to the vault root, e.g. 'PostTraining/wiki/concepts/multi-agent-systems.md' or 'log.md'. If a file is not found, the tool will suggest similar files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file from the vault root. Use exact paths from search_notes or list_notes." }
      },
      required: ["path"]
    }
  },
  {
    type: "function" as const,
    name: "list_notes",
    description: "List files and directories at a given path. If the path points to a file instead of a directory, it will read that file instead. Use '.' for root. Paths like 'log.md' or 'PostTraining/wiki' both work.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to list or read. '.' for root, 'TopicName/wiki' for a subfolder, or 'log.md' for a specific file." }
      }
    }
  },
  {
    type: "function" as const,
    name: "web_search",
    description: "Search the web for information not in the knowledge base. Use this when the user asks about current events, wants to compare their notes with external sources, needs definitions or context beyond what's in the vault, or asks you to research something online.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" }
      },
      required: ["query"]
    }
  },
  {
    type: "function" as const,
    name: "delegate_task",
    description: "Delegate a task to Claude Code for autonomous execution. Use when the user asks for something that requires file editing, deep multi-step research, vault reorganization, creating new notes/articles, running complex commands, or any task needing file system access. The task is queued and the user controls when it executes. Examples: 'write an article about X', 'reorganize my notes on Y', 'research topic Z and create a comprehensive note', 'scrape this website and save the findings'.",
    parameters: {
      type: "object",
      properties: {
        task_description: { type: "string", description: "Clear, detailed description of what Claude Code should do. Be specific about desired outcomes. This will be sent directly as a prompt." },
        priority: { type: "string", enum: ["high", "normal", "low"], description: "Task priority. High = do next, Normal = default, Low = when everything else is done." }
      },
      required: ["task_description"]
    }
  },
  {
    type: "function" as const,
    name: "schedule_recurring_task",
    description: "Create a recurring scheduled task (cron job). Use when the user wants something done regularly: daily news digests, weekly vault maintenance, periodic web scraping, regular topic research. Provide a standard cron expression for the schedule. Common patterns: '0 8 * * *' (daily 8am), '0 8 * * 1' (Mondays 8am), '0 */6 * * *' (every 6 hours), '0 9 * * 1-5' (weekdays 9am).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short descriptive name, e.g. 'Morning News Digest' or 'Weekly Vault Cleanup'" },
        schedule: { type: "string", description: "Cron expression (5 fields: minute hour day-of-month month day-of-week). e.g. '0 8 * * *' for daily at 8am." },
        task_description: { type: "string", description: "Detailed description of what Claude Code should do each time this runs." },
        auto_execute: { type: "boolean", description: "Whether to auto-execute when triggered (true) or just add to queue (false). Default: true." }
      },
      required: ["name", "schedule", "task_description"]
    }
  }
];

// Chat Completions wrapper format. VOICE_TOOLS is authored flat for readability;
// OpenAI requires each tool nested as { type, function: {...} }.
export const CHAT_VOICE_TOOLS = VOICE_TOOLS.map(t => ({
  type: "function" as const,
  function: { name: t.name, description: t.description, parameters: t.parameters }
}));

// READ tools auto-execute (research). WRITE tools mutate external state and could
// benefit from a confirmation preamble — for v1 we still auto-execute them but the
// classification is kept so confirmation can be added cheaply later.
const READ_TOOLS = new Set(["search_notes", "read_note", "list_notes", "web_search"]);
const WRITE_TOOLS = new Set(["delegate_task", "schedule_recurring_task"]);
export function toolKind(name: string): "read" | "write" | "unknown" {
  if (READ_TOOLS.has(name)) return "read";
  if (WRITE_TOOLS.has(name)) return "write";
  return "unknown";
}
