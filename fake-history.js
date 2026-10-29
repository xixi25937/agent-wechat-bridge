// A thread_history_1.sqlite with the columns openAsks reads. Item shapes are copied from a real desktop thread.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const sqlite = await import("node:sqlite").catch(() => null)

export const user = (id, text) => ({ type: "userMessage", id, content: [{ type: "text", text, text_elements: [] }] })
export const agent = (id, text, questions) => ({ type: "agentMessage", id, text, phase: "final_answer", delivery: questions ? "async" : null, questions: questions ?? null })

// items: [threadId, rollout_ordinal, item]. Returns the db path.
export function fakeHistory(items) {
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codex-hist-")), "thread_history_1.sqlite")
  const c = new sqlite.DatabaseSync(db)
  c.exec("create table thread_items (thread_id text, turn_id text, item_id text, rollout_ordinal integer, item_json text, item_type text)")
  const ins = c.prepare("insert into thread_items values (?, 'turn1', ?, ?, ?, ?)")
  for (const [thread, ordinal, item] of items) ins.run(thread, item.id, ordinal, JSON.stringify(item), item.type)
  c.close()
  return db
}
