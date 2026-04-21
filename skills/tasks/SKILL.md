---
name: tasks
description: Manage background tasks and cron jobs via the Pocket Intelligence task queue API
---

# Task Queue Management

You can create background tasks and scheduled cron jobs using the local API. These tasks are executed by a separate Claude Code worker process — they run independently of this terminal session.

## Authentication

All API calls require the internal token passed via environment variable:

```bash
TOKEN=$PI_INTERNAL_TOKEN
PORT=$PI_API_PORT
API="http://localhost:$PORT"
AUTH="-H \"X-Internal-Token: $TOKEN\""
```

## Quick Reference

### Create a task (queued for background execution)

```bash
curl -s -X POST "$API/api/tasks" \
  -H "X-Internal-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Research the latest developments in quantum computing and create wiki articles in the knowledge base", "model": "sonnet"}'
```

Fields:
- `prompt` (required): What the background worker should do
- `model` (optional): "sonnet", "opus", or "haiku" (default: uses system default)
- `priority` (optional): lower = higher priority (10=high, 100=normal, 200=low)
- `timeoutMs` (optional): max execution time in ms (default: 900000 = 15 min)

### Create a cron job (recurring scheduled task)

```bash
curl -s -X POST "$API/api/cron" \
  -H "X-Internal-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Daily Tech News", "schedule": "0 8 * * *", "prompt": "Search for the latest tech news, find articles related to AI and ML, and create concise summaries in the knowledge base", "autoExecute": true}'
```

Fields:
- `name` (required): Human-readable name
- `schedule` (required): Cron expression (5 fields: minute hour day-of-month month day-of-week)
  - `0 8 * * *` = daily at 8am
  - `0 9 * * 1-5` = weekdays at 9am
  - `0 */6 * * *` = every 6 hours
  - `0 20 * * 0` = Sundays at 8pm
- `prompt` (required): What the worker should do each time
- `autoExecute` (optional, default true): auto-run when triggered, or just queue

### List tasks and cron jobs

```bash
# All tasks
curl -s "$API/api/tasks" -H "X-Internal-Token: $TOKEN" | jq .

# All cron jobs
curl -s "$API/api/cron" -H "X-Internal-Token: $TOKEN" | jq .
```

### Execute next pending task

```bash
curl -s -X POST "$API/api/tasks/execute-next" -H "X-Internal-Token: $TOKEN"
```

### Toggle auto-execute

```bash
curl -s -X POST "$API/api/tasks/auto-execute" \
  -H "X-Internal-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

### Cancel, retry, delete

```bash
# Cancel a task
curl -s -X POST "$API/api/tasks/TASK_ID/cancel" -H "X-Internal-Token: $TOKEN"

# Retry a failed task
curl -s -X POST "$API/api/tasks/TASK_ID/retry" -H "X-Internal-Token: $TOKEN"

# Delete a task
curl -s -X DELETE "$API/api/tasks/TASK_ID" -H "X-Internal-Token: $TOKEN"

# Trigger a cron job manually
curl -s -X POST "$API/api/cron/JOB_ID/trigger" -H "X-Internal-Token: $TOKEN"

# Delete a cron job
curl -s -X DELETE "$API/api/cron/JOB_ID" -H "X-Internal-Token: $TOKEN"
```

## Important Notes

- Tasks run in a **separate** Claude Code process, not in this terminal
- The worker has full file system access (same permissions as this session)
- Task output streams to the user's Task Board UI in real time
- Cron jobs create tasks when triggered — the task then enters the queue
- If auto-execute is on, tasks run automatically; otherwise the user clicks "Execute Next" in the UI
- The user can see all tasks, output, and cron jobs in the Tasks tab of the intelligence panel
