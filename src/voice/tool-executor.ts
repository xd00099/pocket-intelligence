import { existsSync, readFileSync, statSync, readdirSync } from "fs";
import { resolve, relative, join } from "path";
import { execSync } from "child_process";
import * as TaskQueue from "../lib/task-queue.js";
import * as CronScheduler from "../lib/cron-scheduler.js";
import { safePath } from "../lib/notes-helpers.js";
import { NOTES_DIR } from "../config.js";
import { broadcastTaskEvent, getAutoExecuteEnabled, tryExecuteNext } from "../task-events.js";

// Execute a voice tool call. Returns { result, debug } — result goes back to the
// planner as a tool message, debug is surfaced to the client for the tool card UI.
// Handles the six VOICE_TOOLS: search_notes, read_note, list_notes, web_search,
// delegate_task, schedule_recurring_task.
export async function executeVoiceTool(name: string, args: Record<string, any>): Promise<{ result: string; debug?: any }> {
  const notesDir = resolve(NOTES_DIR);
  const startTime = Date.now();

  if (!existsSync(notesDir)) {
    return { result: "Knowledge base not available. Notes directory does not exist.", debug: { error: "NOTES_DIR does not exist" } };
  }

  try {
    switch (name) {
      case "search_notes": {
        const query = args.query || "";
        const safeQuery = query.replace(/['"\\`$!(){}[\]|;&<>]/g, "\\$&");

        let fileList = "";
        try {
          fileList = execSync(
            `grep -r -i --include='*.md' -l '${safeQuery}' . 2>/dev/null || true`,
            { cwd: notesDir, encoding: "utf8", timeout: 10000 }
          ).trim();
        } catch (e: any) {
          return { result: `Search failed: ${e.message}`, debug: { tool: "search_notes", query, error: e.message, duration: Date.now() - startTime } };
        }

        if (!fileList) {
          return { result: "No notes found matching that query.", debug: { tool: "search_notes", query, matchCount: 0, duration: Date.now() - startTime } };
        }

        // Clean paths: strip "./" prefix so they work directly with read_note
        const files = fileList.split("\n").filter(Boolean).map(f => f.replace(/^\.\//, ""));
        const topFiles = files.slice(0, 8);
        let output = `Found ${files.length} matching files. Use these exact paths with read_note:\n`;
        const fileDetails: Array<{ path: string; snippet: string }> = [];

        for (const file of topFiles) {
          let snippet = "(no preview)";
          try {
            snippet = execSync(
              `grep -i -C 2 '${safeQuery}' '${file}' 2>/dev/null | head -15 || true`,
              { cwd: notesDir, encoding: "utf8", timeout: 3000 }
            ).trim();
          } catch {}
          output += `\n### ${file}\n${snippet}\n`;
          fileDetails.push({ path: file, snippet });
        }

        if (files.length > 8) {
          output += `\n... and ${files.length - 8} more files`;
        }

        return { result: output.slice(0, 4000), debug: { tool: "search_notes", query, matchCount: files.length, filesSearched: topFiles, allFiles: files, fileDetails, duration: Date.now() - startTime } };
      }

      case "read_note": {
        let userPath = (args.path || "").replace(/^\.\//, "");

        let filePath = safePath(userPath);
        if (filePath && !existsSync(filePath) && !userPath.endsWith(".md")) {
          const withMd = safePath(userPath + ".md");
          if (withMd && existsSync(withMd)) filePath = withMd;
        }

        if (!filePath) {
          return { result: "Invalid path — path traversal blocked.", debug: { tool: "read_note", path: args.path, error: "path_traversal" } };
        }
        if (!existsSync(filePath)) {
          // Fuzzy match: search by filename
          const filename = userPath.split("/").pop() || "";
          const safeFilename = filename.replace(/['"\\`$!(){}[\]|;&<>]/g, "\\$&");
          let suggestion = "";
          try {
            suggestion = execSync(
              `find . -iname '*${safeFilename}*' -type f -not -path '*/\\.*' | head -8`,
              { cwd: notesDir, encoding: "utf8", timeout: 3000 }
            ).trim();
          } catch {}
          const suggestions = suggestion.split("\n").filter(Boolean).map(s => s.replace(/^\.\//, ""));
          return { result: `File not found: ${userPath}` + (suggestions.length ? `\n\nDid you mean:\n${suggestions.join("\n")}` : "\n\nTip: use the exact paths from search_notes results."), debug: { tool: "read_note", path: args.path, normalizedPath: userPath, error: "not_found", suggestions, duration: Date.now() - startTime } };
        }

        const fileStat = statSync(filePath);
        const content = readFileSync(filePath, "utf8");
        const truncated = content.length > 6000;
        const noteText = content.slice(0, 6000) + (truncated ? "\n\n[...truncated]" : "");
        return {
          result: noteText,
          debug: { tool: "read_note", path: args.path, normalizedPath: userPath, resolved: relative(notesDir, filePath), sizeBytes: fileStat.size, totalChars: content.length, truncated, duration: Date.now() - startTime },
        };
      }

      case "list_notes": {
        let userListPath = (args.path || ".").replace(/^\.\//, "");
        let dirPath = safePath(userListPath);
        if (!dirPath) {
          return { result: "Invalid path.", debug: { tool: "list_notes", path: args.path, error: "path_traversal" } };
        }

        if (!existsSync(dirPath) && !userListPath.endsWith(".md")) {
          const withMd = safePath(userListPath + ".md");
          if (withMd && existsSync(withMd)) dirPath = withMd;
        }

        if (!existsSync(dirPath)) {
          const safeName = userListPath.replace(/['"\\`$!(){}[\]|;&<>]/g, "\\$&");
          let suggestion = "";
          try {
            suggestion = execSync(
              `find . -iname '*${safeName}*' -not -path '*/\\.*' | head -8`,
              { cwd: notesDir, encoding: "utf8", timeout: 3000 }
            ).trim();
          } catch {}
          const suggestions = suggestion.split("\n").filter(Boolean).map(s => s.replace(/^\.\//, ""));
          return { result: `Not found: ${userListPath}` + (suggestions.length ? `\n\nDid you mean:\n${suggestions.join("\n")}` : ""), debug: { tool: "list_notes", path: args.path, error: "not_found", suggestions, duration: Date.now() - startTime } };
        }

        // If the path is a file, read it instead of listing
        if (statSync(dirPath).isFile()) {
          const content = readFileSync(dirPath, "utf8");
          const truncated = content.length > 6000;
          return { result: `(${userListPath} is a file, reading it)\n\n${content.slice(0, 6000)}${truncated ? "\n\n[...truncated]" : ""}`, debug: { tool: "list_notes", path: args.path, resolved: relative(notesDir, dirPath), action: "read_file_fallback", sizeBytes: statSync(dirPath).size, totalChars: content.length, truncated, duration: Date.now() - startTime } };
        }

        const entries = readdirSync(dirPath)
          .filter(n => !n.startsWith("."))
          .map(n => {
            const full = join(dirPath, n);
            try {
              const s = statSync(full);
              const isDir = s.isDirectory();
              if (isDir) {
                const children = readdirSync(full).filter(c => !c.startsWith(".")).length;
                return { name: `${n}/`, type: "dir", children };
              }
              return { name: n, type: "file", sizeBytes: s.size };
            } catch {
              return { name: n, type: "unknown" };
            }
          });

        const listing = entries.map(e =>
          e.type === "dir" ? `${e.name} (${(e as any).children} items)` : `${e.name} (${((e as any).sizeBytes / 1024).toFixed(1)}KB)`
        ).join("\n");

        return { result: listing || "(empty directory)", debug: { tool: "list_notes", path: args.path || ".", resolved: relative(notesDir, dirPath) || ".", entries, entryCount: entries.length, duration: Date.now() - startTime } };
      }

      case "web_search": {
        const query = args.query || "";
        if (!query) return { result: "No search query provided." };
        try {
          // DuckDuckGo HTML search — no API key needed.
          const encoded = encodeURIComponent(query);
          const searchUrl = `https://html.duckduckgo.com/html/?q=${encoded}`;
          const response = await fetch(searchUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (compatible; PocketIntelligence/1.0)" }
          });
          const html = await response.text();
          const results: string[] = [];
          const resultRegex = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
          let match;
          while ((match = resultRegex.exec(html)) !== null && results.length < 5) {
            const title = match[2].replace(/<[^>]+>/g, "").trim();
            const snippet = match[3].replace(/<[^>]+>/g, "").trim();
            const url = match[1];
            if (title && snippet) results.push(`**${title}**\n${snippet}\n${url}`);
          }
          if (results.length === 0) {
            // Fallback: simpler extraction when DDG HTML layout drifts
            const linkRegex = /<a rel="nofollow"[^>]*href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>/g;
            while ((match = linkRegex.exec(html)) !== null && results.length < 5) {
              results.push(`${match[2].trim()} — ${match[1]}`);
            }
          }
          const output = results.length > 0
            ? `Web search results for "${query}":\n\n${results.join("\n\n")}`
            : `No web results found for "${query}". Try rephrasing.`;
          return { result: output.slice(0, 4000), debug: { tool: "web_search", query, resultCount: results.length, duration: Date.now() - startTime } };
        } catch (err: any) {
          return { result: `Web search failed: ${err.message}`, debug: { tool: "web_search", query, error: err.message, duration: Date.now() - startTime } };
        }
      }

      case "delegate_task": {
        const priorityMap: Record<string, number> = { high: 10, normal: 100, low: 200 };
        const task = TaskQueue.addTask({
          prompt: args.task_description || "",
          source: "voice",
          sourceLabel: "Voice Agent",
          priority: priorityMap[args.priority || "normal"] || 100,
        });
        broadcastTaskEvent("task:created", task);
        const autoExec = getAutoExecuteEnabled();
        if (autoExec) tryExecuteNext();
        const queuePos = TaskQueue.getPending().findIndex(t => t.id === task.id) + 1;
        return { result: `Task queued successfully (position #${queuePos} in queue). The user can see it in the Tasks tab and choose when to execute it.${autoExec ? " Auto-execute is on, so it will start when the current queue clears." : ""}`, debug: { tool: "delegate_task", taskId: task.id, position: queuePos, autoExecute: autoExec, duration: Date.now() - startTime } };
      }

      case "schedule_recurring_task": {
        if (!CronScheduler.validateSchedule(args.schedule || "")) {
          return { result: `Invalid cron expression: "${args.schedule}". Use 5 fields: minute hour day-of-month month day-of-week. Example: "0 8 * * *" for daily at 8am.`, debug: { tool: "schedule_recurring_task", error: "invalid_cron", duration: Date.now() - startTime } };
        }
        const job = CronScheduler.addJob({
          name: args.name || "Untitled Job",
          schedule: args.schedule,
          prompt: args.task_description || "",
          autoExecute: args.auto_execute !== false,
        });
        if (!job) {
          return { result: "Failed to create scheduled task.", debug: { tool: "schedule_recurring_task", error: "create_failed" } };
        }
        broadcastTaskEvent("cron:created", job);
        return { result: `Recurring task "${job.name}" scheduled with cron "${job.schedule}". ${job.autoExecute ? "It will auto-execute when triggered." : "Tasks will be added to queue for manual approval."}`, debug: { tool: "schedule_recurring_task", jobId: job.id, schedule: job.schedule, duration: Date.now() - startTime } };
      }

      default:
        return { result: `Unknown tool: ${name}`, debug: { error: "unknown_tool", name } };
    }
  } catch (err: any) {
    console.error("Tool execution error:", err);
    return { result: `Tool execution failed: ${err.message}`, debug: { tool: name, error: err.message, stack: err.stack?.split("\n").slice(0, 3), duration: Date.now() - startTime } };
  }
}
