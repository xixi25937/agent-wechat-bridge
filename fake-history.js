// A thread_history_1.sqlite with the columns openAsks and dbTurns read. Item shapes are copied from a real desktop thread.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const sqlite = await import("node:sqlite").catch(() => null)

export const user = (id, text) => ({ type: "userMessage", id, content: [{ type: "text", text, text_elements: [] }] })
export const agent = (id, text, questions) => ({ type: "agentMessage", id, text, phase: "final_answer", delivery: questions ? "async" : null, questions: questions ?? null })

// items: [threadId, rollout_ordinal, item, turnId = "turn1"]. Returns the db path.
// Also the turns table (one row per turn, ordered by its first item; `status[turnId]`, "completed" by default) and the
// projection state: where in its rollout file the db has read to, `offset[threadId]` (1000 by default, so a rollout
// file of 1000 bytes is one the db has caught up with).
export function fakeHistory(items, { status = {}, offset = {} } = {}) {
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codex-hist-")), "thread_history_1.sqlite")
  const c = new sqlite.DatabaseSync(db)
  c.exec("create table thread_items (thread_id text, turn_id text, item_id text, rollout_ordinal integer, item_json text, item_type text)")
  c.exec("create table thread_turns (thread_id text, turn_id text, rollout_ordinal integer, status text)")
  c.exec("create table thread_history_projection_state (thread_id text primary key, next_rollout_byte_offset integer, next_rollout_ordinal integer)")
  const ins = c.prepare("insert into thread_items values (?, ?, ?, ?, ?, ?)")
  const turns = new Map()
  for (const [thread, ordinal, item, turn = "turn1"] of items) {
    ins.run(thread, turn, item.id, ordinal, JSON.stringify(item), item.type)
    const k = `${thread}\n${turn}`
    turns.set(k, [thread, turn, Math.min(ordinal, turns.get(k)?.[2] ?? ordinal), status[turn] ?? "completed"])
  }
  for (const t of turns.values()) c.prepare("insert into thread_turns values (?, ?, ?, ?)").run(...t)
  for (const thread of new Set(items.map((i) => i[0]))) c.prepare("insert into thread_history_projection_state values (?, ?, ?)").run(thread, offset[thread] ?? 1000, 0)
  c.close()
  return db
}
