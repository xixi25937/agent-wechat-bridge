import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

// tag() and prune() read and write the state file, and prune() asks OpenCode and the Codex db. Everything here points at
// a temp folder (set before index.js is loaded): no state file, no service.json, no Codex db of the real user.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wn-tag-"))
Object.assign(process.env, { WECHAT_NOTIFY_DIR: dir, USERPROFILE: dir, HOME: dir, CODEX_HOME: dir })
const { assign, prune, state, tag, tagText, update } = await import("./index.js")

test("tagText", () => {
  assert.equal(tagText(5, "OpenCode", "C:\\Users\\me\\ttool"), "[5] OpenCode · ttool")
  assert.equal(tagText(7, "Codex", "/home/me/proj/"), "[7] Codex · proj")
  assert.equal(tagText(2, "OpenCode", ""), "[2] OpenCode")
})

test("tag: cache first, lookup only when it is missing", async () => {
  const lookups = []
  const find = (v) => async (key) => (lookups.push(key), v)
  // Folder passed by the caller: cached, no lookup.
  assert.equal(await tag("ses_a", "C:\\w\\ttool", find("never")), "[1] OpenCode · ttool")
  assert.deepEqual(state().info.ses_a, { dir: "C:\\w\\ttool" })
  assert.equal(await tag("ses_a", undefined, async () => assert.fail("cached")), "[1] OpenCode · ttool")
  // Nothing cached: one lookup, then cached.
  assert.equal(await tag("ses_b", undefined, find("C:\\w\\todo-app")), "[2] OpenCode · todo-app")
  assert.equal(await tag("ses_b", undefined, find("other")), "[2] OpenCode · todo-app")
  assert.deepEqual(lookups, ["ses_b"])
  // The agent comes from the key prefix.
  assert.equal(await tag("codex:t1", undefined, find("C:\\w\\proj")), "[3] Codex · proj")
  assert.equal(state().info["codex:t1"].dir, "C:\\w\\proj")
  // A new folder from a push replaces the cached one.
  assert.equal(await tag("ses_a", "D:\\moved", find("never")), "[1] OpenCode · moved")
})

test("tag: a failed or empty lookup gives just the agent, and is retried next time", async () => {
  assert.equal(await tag("ses_c", undefined, async () => { throw new Error("down") }), "[4] OpenCode")
  assert.equal(await tag("ses_c", undefined, async () => ""), "[4] OpenCode")
  assert.equal(state().info?.ses_c, undefined)
  assert.equal(await tag("codex:t2", undefined, async () => { throw new Error("no db") }), "[5] Codex")
  assert.equal(await tag("ses_c", undefined, async () => "C:\\w\\later"), "[4] OpenCode · later")
})

test("the recycler drops info[key] with the number", async (t) => {
  let DatabaseSync
  try {
    ;({ DatabaseSync } = await import("node:sqlite"))
  } catch {
    return t.skip("node:sqlite not available")
  }
  // A Codex db that lists only thread "t1" as alive: "codex:t2" counts as deleted and is released.
  const db = new DatabaseSync(path.join(dir, "state_5.sqlite"))
  db.exec("create table threads (id text, archived integer); insert into threads values ('t1', 0)")
  db.close()
  assert.ok(state().nums["codex:t2"] === 5 && state().info["codex:t1"])
  update((s) => {
    s.info["codex:t2"] = { dir: "C:\\w\\gone" }
    delete s.prunedAt // the earlier assign() calls already pruned once
  })
  await prune()
  const s = state()
  assert.equal(s.nums["codex:t2"], undefined, "number released")
  assert.equal(s.info["codex:t2"], undefined, "folder dropped with it")
  assert.deepEqual(Object.keys(s.info).sort(), ["codex:t1", "ses_a", "ses_b", "ses_c"], "the others keep theirs")
  assert.equal(s.nums["codex:t1"], 3, "an existing thread keeps its number")
  assert.equal(await assign("codex:t3"), 5, "the freed number is handed out again")
})

test.after(() => fs.rmSync(dir, { recursive: true, force: true }))
