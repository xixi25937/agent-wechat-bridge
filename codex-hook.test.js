import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { codexHead, decisionOutput, isSubagent, onPermission, permissionSummary, threadInfo } from "./codex-hook.js"
import { answerCodex, base, readPending, short } from "./index.js"

test("codexHead", () => {
  const h = (cwd, t) => codexHead(7, cwd, t, { base, short })
  assert.equal(h("\\\\?\\C:\\Users\\me\\proj", { name: "修登录", title: "帮我修登录" }), "[7] Codex · proj / 修登录")
  assert.equal(h("C:\\a\\b", { name: null, title: "第一句话" }), "[7] Codex · b / 第一句话")
  assert.equal(h("", { cwd: "\\\\?\\D:\\x" }), "[7] Codex · x / 未命名会话")
  assert.equal(h("C:\\a\\b", null), "[7] Codex · b / 未命名会话")
})

test("isSubagent", () => {
  assert.equal(isSubagent({ thread_source: "user", source: "vscode" }), false)
  assert.equal(isSubagent({ thread_source: "subagent" }), true)
  assert.equal(isSubagent({ thread_source: "guardian_review" }), true)
  assert.equal(isSubagent({ source: '{"subagent":{"thread_spawn":{}}}' }), true)
  assert.equal(isSubagent(null), false)
})

test("permissionSummary", () => {
  assert.equal(permissionSummary({ tool_name: "Bash", tool_input: { command: "git push", description: "推送到远端" } }, short), "git push （推送到远端）")
  const patch = "*** Begin Patch\n*** Add File: a.txt\n+x\n*** Update File: src/b.js\n@@\n*** Delete File: c.md\n*** End Patch"
  assert.equal(permissionSummary({ tool_name: "apply_patch", tool_input: { command: patch } }, short), "改文件：新建 a.txt，修改 src/b.js，删除 c.md")
  assert.equal(permissionSummary({ tool_name: "mcp__fs__write", tool_input: { path: "x" } }, short), 'mcp__fs__write {"path":"x"}')
  assert.equal(permissionSummary({ tool_name: "Bash", tool_input: { command: ["git", "status"] } }, short), "git status")
})

test("decisionOutput", () => {
  assert.deepEqual(JSON.parse(decisionOutput("allow")), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } })
  assert.equal(JSON.parse(decisionOutput("deny")).hookSpecificOutput.decision.behavior, "deny")
  // Timeout or a garbled answer file: no decision, Codex falls back to its own prompt.
  assert.equal(decisionOutput(""), "")
  assert.equal(decisionOutput("maybe"), "")
})

test("pending handshake", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-pending-"))
  const put = (id, n, created) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, n, created }))
  put("b", 3, 2)
  put("a", 3, 1)
  put("c", 4, 3)
  assert.deepEqual(readPending(dir).map((p) => p.id), ["a", "b", "c"])
  assert.deepEqual(answerCodex(readPending(dir), 3, "allow", dir), ["a"])
  assert.equal(fs.readFileSync(path.join(dir, "a.answer"), "utf-8"), "allow")
  assert.deepEqual(readPending(dir).map((p) => p.id), ["b", "c"])
  assert.deepEqual(answerCodex(readPending(dir), 9, "allow", dir), [])
  put("d", 4, 4)
  assert.deepEqual(answerCodex(readPending(dir), 4, "deny", dir), ["c", "d"])
  assert.deepEqual(readPending(path.join(dir, "missing")), [])
  fs.rmSync(dir, { recursive: true })
})

test("onPermission answer and timeout", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-pending-"))
  const sent = []
  const m = { PENDING_DIR: dir, base, short, numOf: () => 5, update: () => {}, state: () => ({ pollerPid: process.pid }), send: async (t) => (sent.push(t), "ok") }
  const p = { session_id: "t", cwd: "C:\\a\\proj", tool_name: "Bash", tool_input: { command: "git push" } }
  // Timeout: no decision, a timeout push, files removed.
  assert.equal(await onPermission(p, m, 0.05), "")
  assert.match(sent[0], /^\[5\] Codex · proj \/ .+\n等你批准：git push\n回复「5 y」批准/)
  assert.equal(sent[1], "[5] 超时，回电脑上处理")
  assert.deepEqual(fs.readdirSync(dir), [])
  // Answered through the plugin's code path.
  const waiting = onPermission(p, m, 5)
  while (!readPending(dir).length) await new Promise((r) => setTimeout(r, 20))
  answerCodex(readPending(dir), 5, "deny", dir)
  assert.equal(JSON.parse(await waiting).hookSpecificOutput.decision.behavior, "deny")
  assert.deepEqual(fs.readdirSync(dir), [])
  // No poller: push says replies won't work, no waiting.
  sent.length = 0
  assert.equal(await onPermission(p, { ...m, state: () => ({}) }, 5), "")
  assert.match(sent[0], /微信回复收不到/)
  fs.rmSync(dir, { recursive: true })
})

test("threadInfo missing db", async () => {
  assert.equal(await threadInfo("x", path.join(os.tmpdir(), "no-such-codex.sqlite")), null)
})
