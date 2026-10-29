import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { readQuestion } from "./codex-question.js"
import { approvalMode, codexHead, decisionOutput, isSubagent, onPermission, onQuestion, permissionSummary, remember, threadInfo } from "./codex-hook.js"
import { fakeDesktop } from "./fake-desktop.js"
import { answerCodex, base, readPending, short } from "./index.js"

test("codexHead", () => {
  const h = (cwd, t) => codexHead(7, cwd, t, { base, short })
  assert.equal(h("\\\\?\\C:\\Users\\me\\proj", { name: "修登录", title: "帮我修登录" }), "[7] Codex · proj / 修登录")
  assert.equal(h("C:\\a\\b", { name: null, title: "第一句话" }), "[7] Codex · b / 第一句话")
  assert.equal(h("", { cwd: "\\\\?\\D:\\x" }), "[7] Codex · x / 未命名会话")
  assert.equal(h("C:\\a\\b", null), "[7] Codex · b / 未命名会话")
})

test("remember: latest conversation and its folder go to the state", () => {
  const s = {}
  remember(s, "codex:t", "\\\\?\\C:\\a\\proj", null)
  assert.deepEqual(s, { last: "codex:t", info: { "codex:t": { dir: "C:\\a\\proj" } } })
  remember(s, "codex:u", "", { cwd: "D:\\x" })
  assert.equal(s.info["codex:u"].dir, "D:\\x", "the thread's folder when the payload has none")
  remember(s, "codex:v", "", null)
  assert.equal(s.last, "codex:v")
  assert.equal(s.info["codex:v"], undefined, "no folder known: nothing cached")
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
  const t0 = Date.now()
  const put = (id, n, created) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, n, created: t0 + created }))
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

test("onPermission terminal: short wait, answer or timeout", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-pending-"))
  const sent = []
  const m = { PENDING_DIR: dir, base, short, assign: async () => 5, update: () => {}, state: () => ({ pollerPid: process.pid }), send: async (t) => (sent.push(t), "ok") }
  const p = { session_id: "t", cwd: "C:\\a\\proj", tool_name: "Bash", tool_input: { command: "git push" } }
  // Timeout: no decision, no extra push, the record stays as done so a late 「5 y」 says the computer handled it.
  assert.equal(await onPermission(p, m, { waitS: 0.05, mode: "wait" }), "")
  assert.match(sent[0], /^\[5\] Codex · proj \/ .+\n等你批准：git push\n回复「5 y」批准，「5 n」拒绝（0.05 秒内/)
  assert.equal(sent.length, 1)
  const [late] = readPending(dir)
  assert.ok(late.done)
  assert.deepEqual(answerCodex(readPending(dir), 5, "allow", dir), [])
  fs.rmSync(path.join(dir, `${late.id}.json`))
  // Answered through the plugin's code path.
  const waiting = onPermission(p, m, { waitS: 5, mode: "wait" })
  while (!readPending(dir).length) await new Promise((r) => setTimeout(r, 20))
  answerCodex(readPending(dir), 5, "deny", dir)
  assert.equal(JSON.parse(await waiting).hookSpecificOutput.decision.behavior, "deny")
  assert.deepEqual(fs.readdirSync(dir), [])
  // No poller: push says replies won't work, no waiting.
  sent.length = 0
  assert.equal(await onPermission(p, { ...m, state: () => ({}) }, { waitS: 5 }), "")
  assert.match(sent[0], /微信回复收不到/)
  fs.rmSync(dir, { recursive: true })
})

test("onPermission desktop and bridge return at once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-pending-"))
  const sent = []
  const m = { PENDING_DIR: dir, base, short, assign: async () => 6, update: () => {}, state: () => ({ pollerPid: process.pid }), send: async (t) => (sent.push(t), "ok") }
  const p = { session_id: "d", cwd: "C:\\a\\proj", tool_name: "Bash", tool_input: { command: "ls" } }
  const t0 = Date.now()
  assert.equal(await onPermission(p, m, { waitS: 30, mode: "desktop" }), "")
  assert.ok(Date.now() - t0 < 2000)
  assert.match(sent[0], /电脑上也可以直接点/)
  assert.equal(readPending(dir)[0].mode, "desktop")
  // A desktop record is never answered through a file.
  assert.deepEqual(answerCodex(readPending(dir), 6, "allow", dir), [])
  fs.rmSync(dir, { recursive: true })
})

test("onPermission bridge: silent, the plugin pushes", async () => {
  const sent = []
  const m = { PENDING_DIR: os.tmpdir(), base, short, assign: async () => 7, update: () => {}, state: () => ({ pollerPid: process.pid }), send: async (t) => (sent.push(t), "ok") }
  assert.equal(await onPermission({ session_id: "b", tool_name: "Bash", tool_input: {} }, m, { mode: "bridge" }), "")
  assert.deepEqual(sent, [])
})

test("approvalMode", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-pending-"))
  fs.writeFileSync(path.join(dir, "bridge-b1.run"), "1")
  assert.equal(await approvalMode("b1", dir, async () => true), "bridge")
  assert.equal(await approvalMode("x", dir, async () => true), "desktop")
  assert.equal(await approvalMode("x", dir, async () => false), "wait")
  assert.equal(await approvalMode("x", dir, async () => { throw new Error("pipe") }), "wait")
  fs.rmSync(dir, { recursive: true })
})

test("readPending drops stale records", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-pending-"))
  fs.writeFileSync(path.join(dir, "old.json"), JSON.stringify({ id: "old", n: 1, created: 0 }))
  fs.writeFileSync(path.join(dir, "new.json"), JSON.stringify({ id: "new", n: 1, created: Date.now() }))
  fs.writeFileSync(path.join(dir, "bridge-x.run"), "1")
  assert.deepEqual(readPending(dir).map((p) => p.id), ["new"])
  assert.ok(!fs.existsSync(path.join(dir, "old.json")))
  fs.rmSync(dir, { recursive: true })
})

test("threadInfo missing db", async () => {
  assert.equal(await threadInfo("x", path.join(os.tmpdir(), "no-such-codex.sqlite")), null)
})

const ASK = {
  method: "item/tool/requestUserInput",
  id: 7,
  params: {
    threadId: "t1",
    questions: [
      { id: "color", header: "颜色", question: "喜欢哪个颜色？", isOther: true, isSecret: false, options: [{ label: "红", description: "" }, { label: "蓝", description: "" }] },
      { id: "num", header: "数字", question: "一个数字", isOther: true, isSecret: false, options: null },
    ],
  },
}

test("onQuestion: waits for the window's question, pushes it, leaves a record", { skip: process.platform !== "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-pending-"))
  const sent = []
  const m = { PENDING_DIR: dir, base, short, assign: async () => 5, update: () => {}, state: () => ({ pollerPid: process.pid }), send: async (t) => (sent.push(t), "ok") }
  const p = { session_id: "qt1", cwd: "C:\\a\\proj", tool_name: "request_user_input", tool_input: { questions: [] } }
  const requests = []
  const d = await fakeDesktop({ owns: true, requests })
  // The hook runs before the window has the request.
  setTimeout(() => requests.push(ASK), 60)
  const opts = { pipe: d.pipe, tries: 50, gap: 20 }
  assert.equal(await onQuestion(p, m, opts), "[5] ok")
  assert.equal(sent.length, 1)
  assert.match(sent[0], /^\[5\] Codex · proj \/ .+\n有问题问你：\n问题 1\/2：颜色：喜欢哪个颜色？（也可以直接写答案）\n  1\. 红\n  2\. 蓝\n问题 2\/2：数字：一个数字\n回复「5 答案」：一次回完就一行一个、按顺序（或「1\. 答案」），也可以一条一个\n（电脑上也可以直接答）$/)
  assert.ok(!/忽略/.test(sent[0]), "a Codex question can't be ignored")
  const rec = readQuestion(dir, "qt1")
  assert.deepEqual([rec.n, rec.requestIds], [5, [7]])
  // A second hook for the same pending request pushes nothing.
  assert.equal(await onQuestion(p, m, { ...opts, tries: 3 }), "no question showed up")
  assert.equal(sent.length, 1)
  d.close()
  // No poller: the push says so, and no record is kept for replies that can't arrive.
  fs.rmSync(path.join(dir, "questions"), { recursive: true })
  const d2 = await fakeDesktop({ owns: true, requests })
  await onQuestion(p, { ...m, state: () => ({}) }, { pipe: d2.pipe, tries: 2, gap: 5 })
  assert.match(sent[1], /微信回复收不到，请在电脑上回答/)
  assert.equal(readQuestion(dir, "qt1"), null)
  d2.close()
  // A terminal (no window has the thread): nothing is pushed.
  const none = await fakeDesktop({ owns: false, requests })
  assert.equal(await onQuestion(p, m, { pipe: none.pipe, tries: 2, gap: 5 }), "not in a desktop window")
  assert.equal(sent.length, 2)
  none.close()
  fs.rmSync(dir, { recursive: true })
})

test("PreToolUse entry point: other tools and bridge turns do nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-env-"))
  const hook = path.join(path.dirname(fileURLToPath(import.meta.url)), "codex-hook.js")
  const run = (payload) => spawnSync(process.execPath, [hook, "PreToolUse"], { input: JSON.stringify(payload), env: { ...process.env, WECHAT_NOTIFY_DIR: dir }, encoding: "utf-8", timeout: 20_000 })
  fs.mkdirSync(path.join(dir, "codex-pending"), { recursive: true })
  fs.writeFileSync(path.join(dir, "codex-pending", "bridge-b1.run"), "1")
  for (const payload of [{ session_id: "x", tool_name: "Bash", tool_input: {} }, { session_id: "b1", tool_name: "request_user_input", tool_input: {} }]) {
    const r = run(payload)
    assert.equal(r.status, 0)
    assert.equal(r.stdout, "")
    assert.equal(r.stderr, "")
  }
  // Nothing was handed to a detached child.
  assert.ok(!fs.existsSync(path.join(dir, "codex-hook.log")))
  fs.rmSync(dir, { recursive: true })
})
