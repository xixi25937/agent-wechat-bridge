import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import {
  approvalSummary, bridgeMarker, codexMsgs, createBridge, dbTurns, decisionRequest, desktopApprove, desktopCompact, desktopInterrupt, desktopOwns, desktopSend,
  frame, pendingApprovals, questionResult, serverResponse, startTurnParams, unframe,
} from "./codex.js"
import { fakeDesktop } from "./fake-desktop.js"
import { agent, fakeHistory, sqlite, user } from "./fake-history.js"

test("frame / unframe", () => {
  const a = frame({ type: "request", method: "initialize", params: { t: "中文" } })
  assert.equal(a.readUInt32LE(0), a.length - 4)
  const b = frame({ x: 2 })
  const both = Buffer.concat([a, b])
  // Split mid-frame: the first message comes out, the rest waits for more bytes.
  const r1 = unframe(both.subarray(0, a.length + 3))
  assert.deepEqual(r1.msgs, [{ type: "request", method: "initialize", params: { t: "中文" } }])
  assert.equal(r1.rest.length, 3)
  assert.deepEqual(unframe(Buffer.concat([r1.rest, both.subarray(a.length + 3)])).msgs, [{ x: 2 }])
})

test("approval params", () => {
  const cmd = { method: "item/commandExecution/requestApproval", id: 7, params: {} }
  const file = { method: "item/fileChange/requestApproval", id: "r2", params: {} }
  const perm = { method: "item/permissions/requestApproval", id: 9, params: { permissions: { network: { enabled: true }, fileSystem: null } } }
  assert.deepEqual(decisionRequest("t1", cmd, true), ["thread-follower-command-approval-decision", { conversationId: "t1", requestId: 7, decision: "accept" }])
  assert.deepEqual(decisionRequest("t1", file, false), ["thread-follower-file-approval-decision", { conversationId: "t1", requestId: "r2", decision: "decline" }])
  assert.deepEqual(decisionRequest("t1", perm, true), [
    "thread-follower-permissions-request-approval-response",
    { conversationId: "t1", requestId: 9, response: { permissions: { network: { enabled: true } }, scope: "turn" } },
  ])
  assert.deepEqual(serverResponse(perm, false), { permissions: {}, scope: "turn" })
  assert.deepEqual(serverResponse(cmd, false), { decision: "decline" })
  assert.equal(approvalSummary({ ...cmd, params: { command: "npm i", reason: "联网" } }), "npm i（联网）")
  assert.equal(approvalSummary(file), "改文件")
  const state = { requests: [cmd, { method: "item/tool/requestUserInput", id: 3 }, { method: "item/plan/requestImplementation", id: "p" }, file] }
  assert.deepEqual(pendingApprovals(state).map((r) => r.id), [7, "r2"])
  assert.deepEqual(pendingApprovals(null), [])
  assert.deepEqual(startTurnParams("t1", "hi"), {
    conversationId: "t1",
    turnStart: { request: { threadId: "t1", input: [{ type: "text", text: "hi", text_elements: [] }] }, context: {} },
  })
  assert.deepEqual(startTurnParams("t1", "看", { images: ["C:\\a.png"], model: "m1" }).turnStart.request, {
    threadId: "t1",
    input: [{ type: "text", text: "看", text_elements: [] }, { type: "localImage", path: "C:\\a.png" }],
    model: "m1",
  })
})

test("questionResult", () => {
  assert.deepEqual(questionResult({ q1: "MySQL", q2: "小明" }), { answers: { q1: { answers: ["MySQL"] }, q2: { answers: ["小明"] } } })
})

test("codexMsgs", () => {
  // thread/turns/list desc: newest turn first.
  const turns = [
    { items: [{ type: "userMessage", content: [{ type: "text", text: "改一下" }] }, { type: "commandExecution" }, { type: "reasoning" }, { type: "agentMessage", text: "改好了" }] },
    { items: [{ type: "userMessage", content: [{ type: "text", text: "在吗" }, { type: "localImage", path: "x" }] }, { type: "agentMessage", text: "在" }] },
  ]
  assert.deepEqual(codexMsgs(turns), [
    { type: "assistant", content: [{ type: "text", text: "改好了" }] },
    { type: "assistant", content: [{ type: "tool", name: "shell" }] },
    { type: "user", text: "改一下" },
    { type: "assistant", content: [{ type: "text", text: "在" }] },
    { type: "user", text: "在吗" },
  ])
})

test("desktop approve and send over the pipe", { skip: process.platform !== "win32" }, async () => {
  const requests = [
    { method: "item/commandExecution/requestApproval", id: 11, params: {} },
    { method: "item/fileChange/requestApproval", id: 12, params: {} },
  ]
  const d = await fakeDesktop({ owns: true, requests })
  assert.equal(await desktopOwns("t1", d.pipe), true)
  assert.equal(await desktopApprove("t1", true, d.pipe), 1)
  const asks = (method) => d.got.filter((m) => m.method === method)
  const [dec] = asks("thread-follower-command-approval-decision")
  assert.equal(dec.version, 1)
  assert.deepEqual(dec.params, { conversationId: "t1", requestId: 11, decision: "accept" })
  assert.equal(asks("initialize")[0].version, 0)
  // Follow, then unfollow once the snapshot arrived.
  assert.deepEqual(asks("thread-stream-following-changed").map((m) => m.params.following), [true, false])
  assert.equal(await desktopApprove("t1", false, d.pipe), 2)
  assert.equal(await desktopSend("t1", "只回复：好的", d.pipe), true)
  const [st] = asks("thread-follower-start-turn")
  assert.equal(st.version, 2)
  assert.deepEqual(st.params, startTurnParams("t1", "只回复：好的"))
  assert.equal(await desktopSend("t1", "看", d.pipe, { images: ["C:\\a.png"] }), true)
  assert.deepEqual(asks("thread-follower-start-turn")[1].params.turnStart.request.input[1], { type: "localImage", path: "C:\\a.png" })
  assert.equal(await desktopInterrupt("t1", d.pipe), "turn-9")
  const [it] = asks("thread-follower-interrupt-turn")
  assert.equal(it.version, 4)
  assert.deepEqual(it.params, { conversationId: "t1", mode: "user-stop" })
  assert.equal(await desktopCompact("t1", d.pipe), true)
  assert.deepEqual(asks("thread-follower-compact-thread")[0].params, { conversationId: "t1" })
  d.close()
  const none = await fakeDesktop({ owns: false, requests })
  assert.equal(await desktopApprove("t1", true, none.pipe), null)
  assert.equal(await desktopSend("t1", "x", none.pipe), false)
  assert.equal(await desktopInterrupt("t1", none.pipe), null)
  assert.equal(await desktopCompact("t1", none.pipe), false)
  none.close()
  // Desktop not running at all.
  assert.equal(await desktopOwns("t1", `\\\\.\\pipe\\wx-test-missing`), false)
})

test("bridge: resume, held approval, question, completion, stop", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-"))
  const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-app-server.js")
  const pushed = []
  const b = createBridge({ push: (...a) => pushed.push(a), markerDir: dir, bin: () => [process.execPath, fake] })
  const until = async (f) => {
    for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10))
    assert.ok(f())
  }
  try {
    assert.equal(b.reply("t1", "x", 4), null)
    await b.send("t1", "只回复：好的")
    assert.ok(b.running("t1"))
    assert.ok(fs.existsSync(bridgeMarker(dir, "t1")))
    // The fake asks two questions, then a command approval, then sends its reply and completes.
    await until(() => pushed.length === 1)
    assert.equal(pushed[0][1], "question")
    assert.deepEqual(pushed[0][2].map((q) => q.id), ["q", "pw"])
    assert.equal(b.approve("t1", true), 0)
    // Step by step: a wrong option is asked again, the first answer is kept on the held request.
    assert.match(b.reply("t1", "C", 4, "[4] Codex · proj"), /^\[4\] Codex · proj 第 1 题：「C」不是选项/)
    assert.match(b.reply("t1", "1", 4), /^\[4\] 已记下 1\/2，下一个：\n\n问题 2\/2：密码（保密内容，会经过微信）/)
    assert.match(b.reply("t1", "-", 4), /这一题必须回答/)
    assert.match(b.reply("t1", "忽略", 4), /没法忽略/)
    assert.equal(b.reply("t1", "hunter2", 4, "[4] Codex · proj"), "已回答 [4] Codex · proj")
    await until(() => pushed.length === 2)
    assert.deepEqual(pushed[1], ["t1", "approval", "git push（推送）"])
    assert.equal(b.approve("t1", true), 1)
    await until(() => !b.running("t1"))
    // Each finished agent message is reported for live progress, then the turn's end with the last one.
    assert.deepEqual(pushed[2], ["t1", "text", "好的"])
    assert.deepEqual(pushed[3], ["t1", "done", "好的"])
    assert.ok(!fs.existsSync(bridgeMarker(dir, "t1")))
    // The fake fails resume for this id, like a thread a terminal is writing.
    await assert.rejects(b.send("busy", "x"), /正在电脑上打开/)
    assert.equal(b.running("busy"), false)
    assert.equal(await b.create("C:\\x", "hi"), "new-thread")
    // Images and model go into turn/start; /stop interrupts the turn we started; /compact runs as its own turn.
    const of = (id) => pushed.filter((p) => p[0] === id && p[1] !== "text")
    await b.send("echo", "看图", { images: ["C:\\a.png"], model: "m1" })
    await until(() => of("echo").length)
    assert.equal(of("echo")[0][1], "done")
    assert.deepEqual(JSON.parse(of("echo")[0][2]), { input: [{ type: "text", text: "看图", text_elements: [] }, { type: "localImage", path: "C:\\a.png" }], model: "m1" })
    assert.deepEqual((await b.models()).map((m) => m.model), ["m1"])
    assert.equal(await b.interrupt("slow"), false)
    await b.send("slow", "数到 300")
    assert.equal(await b.interrupt("slow"), true)
    await until(() => !b.running("slow"))
    assert.deepEqual(of("slow"), [["slow", "end", ""]], "an interrupted turn only drops its live progress")
    await b.compact("t1")
    await until(() => of("t1").length === 4)
    assert.deepEqual(of("t1")[3], ["t1", "info", "上下文已压缩"])
    // 「撤回」: thread/revert before the given turn; a thread a terminal holds is refused like any other resume.
    await b.revert("t1", "turn1")
    await assert.rejects(b.revert("t1", "nope"), /unknown turn/)
    await assert.rejects(b.revert("busy", "turn1"), /正在电脑上打开/)
  } finally {
    b.stop()
  }
  assert.ok(!fs.existsSync(bridgeMarker(dir, "new-thread")))
  fs.rmSync(dir, { recursive: true })
})

// --- the kept-up app-server (warm) ---

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-app-server.js")
const nap = (ms) => new Promise((r) => setTimeout(r, ms))
async function wait(f, ms = 5000) {
  for (const end = Date.now() + ms; !f() && Date.now() < end; ) await nap(5)
  assert.ok(f(), "timed out")
}
const alive = (pid) => {
  try {
    return process.kill(pid, 0), true
  } catch {
    return false
  }
}

// A bridge on the fake app-server. starts() lists the pid of every server it started, logs what it reported.
function warmBridge(opts = {}, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-warm-"))
  const pids = path.join(dir, "pids")
  Object.assign(process.env, { FAKE_PID_FILE: pids, FAKE_FAIL_STARTS: "0", FAKE_INIT_MS: "0", ...env })
  const logs = []
  const b = createBridge({ push: () => {}, markerDir: dir, bin: () => [process.execPath, FAKE], log: (t) => logs.push(t), ...opts })
  const starts = () => (fs.existsSync(pids) ? fs.readFileSync(pids, "utf8").trim().split("\n").filter(Boolean).map(Number) : [])
  const ready = () => logs.filter((l) => /已就绪/.test(l)).length
  const waits = () => logs.filter((l) => /重新启动/.test(l)).map((l) => Number(l.match(/，([\d.]+) 秒/)[1]))
  const done = () => {
    b.stop()
    for (const k of ["FAKE_PID_FILE", "FAKE_FAIL_STARTS", "FAKE_INIT_MS"]) delete process.env[k]
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return { b, logs, starts, ready, waits, done }
}

test("warm bridge: starts at once and never idles out; a bridge started on demand does", async () => {
  const w = warmBridge({ idleMs: 40 })
  try {
    w.b.warm(true)
    await wait(() => w.ready() === 1)
    const [pid] = w.starts()
    await nap(300) // several idle periods
    assert.ok(alive(pid))
    await w.b.send("echo", "hi")
    await wait(() => !w.b.running("echo"))
    assert.deepEqual(w.starts(), [pid], "the send used the running server")
    assert.equal(w.b.warm(false), false, "no turn of ours runs: it stops now")
    await wait(() => !alive(pid))
  } finally {
    w.done()
  }
  const c = warmBridge({ idleMs: 40, restartMs: [10] })
  try {
    await c.b.models()
    const [pid] = c.starts()
    await wait(() => !alive(pid))
    // A server nobody keeps up is not started again after it dies.
    await c.b.models()
    process.kill(c.starts()[1])
    await nap(100)
    assert.equal(c.starts().length, 2)
  } finally {
    c.done()
  }
})

test("warm bridge: stopping waits for a running turn of ours, and a new warm(true) cancels the wait", async () => {
  const w = warmBridge()
  try {
    w.b.warm(true)
    await wait(() => w.ready() === 1)
    const [pid] = w.starts()
    await w.b.send("slow", "数到 300")
    assert.equal(w.b.warm(false), true, "the turn is still running")
    await nap(150)
    assert.ok(alive(pid), "not killed mid-turn")
    assert.equal(await w.b.interrupt("slow"), true)
    await wait(() => !alive(pid))
    assert.equal(w.b.running("slow"), false)
    // Kept up again, a stop that waits for a turn is called off by the next warm(true).
    w.b.warm(true)
    await wait(() => w.starts().length === 2 && w.ready() === 2)
    await w.b.send("slow", "again")
    assert.equal(w.b.warm(false), true)
    w.b.warm(true)
    assert.equal(await w.b.interrupt("slow"), true)
    await wait(() => !w.b.running("slow"))
    await nap(150)
    assert.ok(alive(w.starts()[1]))
    assert.equal(w.starts().length, 2)
  } finally {
    w.done()
  }
})

test("warm bridge: restarts after a crash with growing waits, and starts over once it stayed up", async () => {
  const w = warmBridge({ restartMs: [40, 80, 160], stableMs: 300 })
  try {
    w.b.warm(true)
    for (let i = 1; i <= 4; i++) {
      await wait(() => w.ready() === i)
      process.kill(w.starts()[i - 1])
      if (i === 1) {
        await nap(15)
        assert.equal(w.starts().length, 1, "no restart before the wait is over")
      }
      await wait(() => w.starts().length === i + 1)
    }
    assert.deepEqual(w.waits(), [0.04, 0.08, 0.16, 0.16], "the last wait repeats")
    await wait(() => w.ready() === 5)
    await nap(350)
    process.kill(w.starts()[4])
    await wait(() => w.starts().length === 6)
    assert.equal(w.waits().at(-1), 0.04, "a server that stayed up has the first wait again")
  } finally {
    w.done()
  }
})

test("warm bridge: a server that dies at launch is retried with waits, then works", async () => {
  const w = warmBridge({ restartMs: [30, 60, 120] }, { FAKE_FAIL_STARTS: "2" })
  try {
    w.b.warm(true)
    await wait(() => w.starts().length === 3 && w.ready() === 1)
    assert.deepEqual(w.waits(), [0.03, 0.06])
    assert.deepEqual((await w.b.models()).map((m) => m.model), ["m1"])
    assert.equal(w.starts().length, 3)
  } finally {
    w.done()
  }
})

test("warm bridge: a missing codex program is reported once and not retried", async () => {
  const logs = []
  const b = createBridge({ push() {}, bin: () => ["wx-no-such-program-xyz"], log: (t) => logs.push(t), restartMs: [10] })
  try {
    b.warm(true)
    await wait(() => logs.length)
    await nap(150)
    assert.equal(logs.length, 1)
    assert.match(logs[0], /找不到 codex/)
  } finally {
    b.stop()
  }
})

test("warm bridge: a server that never answers initialize is stopped and started again", async () => {
  const w = warmBridge({ initMs: 80, restartMs: [30] }, { FAKE_INIT_MS: "1500" })
  try {
    w.b.warm(true)
    await wait(() => w.starts().length === 2)
    await wait(() => !alive(w.starts()[0]))
    await assert.rejects(w.b.models(), /启动超时/)
  } finally {
    w.done()
  }
})

test("warm bridge: revive starts a lost server at once, but only for a kept-up bridge", async () => {
  const w = warmBridge({ restartMs: [10_000] })
  try {
    w.b.warm(true)
    await wait(() => w.ready() === 1)
    w.b.revive()
    await nap(50)
    assert.equal(w.starts().length, 1, "a running server is left alone")
    process.kill(w.starts()[0])
    await wait(() => w.waits().length === 1)
    w.b.revive()
    await wait(() => w.starts().length === 2 && w.ready() === 2)
    w.b.warm(false)
    await wait(() => !alive(w.starts()[1]))
    w.b.revive()
    await nap(100)
    assert.equal(w.starts().length, 2, "not kept up: nothing to bring back")
  } finally {
    w.done()
  }
})

test("dbTurns: the newest turns from the history db, as thread/turns/list shapes them", { skip: !sqlite }, async () => {
  const cmd = { type: "commandExecution", id: "c1", command: "ls" }
  const think = { type: "reasoning", id: "r1" }
  const db = fakeHistory(
    [
      ["t1", 1, user("u1", "第一问"), "turn1"],
      ["t1", 2, agent("a1", "第一答"), "turn1"],
      ["t1", 3, user("u2", "第二问"), "turn2"],
      ["t1", 4, cmd, "turn2"],
      ["t1", 5, think, "turn2"],
      ["t1", 6, agent("a2", "第二答"), "turn2"],
      ["t2", 1, user("x", "别的对话"), "turnx"],
    ],
    { status: { turn2: "inProgress" } },
  )
  const dir = path.dirname(db)
  const rollout = path.join(dir, "rollout.jsonl")
  fs.writeFileSync(rollout, "x".repeat(1000))
  const app = [
    { id: "turn2", status: "inProgress", items: [user("u2", "第二问"), cmd, think, agent("a2", "第二答")] },
    { id: "turn1", status: "completed", items: [user("u1", "第一问"), agent("a1", "第一答")] },
  ]
  const turns = await dbTurns("t1", 2, { db, rollout })
  assert.deepEqual(turns, app)
  assert.deepEqual(codexMsgs(turns), codexMsgs(app))
  assert.deepEqual((await dbTurns("t1", 1, { db, rollout })).map((t) => t.id), ["turn2"])
  assert.deepEqual((await dbTurns("t2", 5, { db, rollout })).map((t) => t.id), ["turnx"])
  // Only a db that ends where the rollout file ends is trusted.
  fs.writeFileSync(rollout, "x".repeat(1001))
  assert.equal(await dbTurns("t1", 2, { db, rollout }), null, "the rollout grew: a turn is still being written")
  fs.writeFileSync(rollout, "x".repeat(999))
  assert.equal(await dbTurns("t1", 2, { db, rollout }), null, "the rollout was rewritten")
  fs.writeFileSync(rollout, "x".repeat(1000))
  assert.equal(await dbTurns("t1", 2, { db, rollout: path.join(dir, "gone.jsonl") }), null, "no rollout file (compressed)")
  assert.equal(await dbTurns("t1", 2, { db }), null, "no rollout given")
  assert.equal(await dbTurns("nope", 2, { db, rollout }), null)
  assert.equal(await dbTurns("t1", 2, { db: path.join(dir, "no.sqlite"), rollout }), null)
  fs.rmSync(dir, { recursive: true })
})
