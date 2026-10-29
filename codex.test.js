import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import {
  approvalSummary, bridgeMarker, codexMsgs, createBridge, decisionRequest, desktopApprove, desktopCompact, desktopInterrupt, desktopOwns, desktopSend, frame,
  pendingApprovals, questionAnswers, questionText, serverResponse, startTurnParams, unframe,
} from "./codex.js"

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

test("questions", () => {
  const one = [{ id: "q1", header: "数据库", question: "用哪个？", options: [{ label: "Postgres" }, { label: "MySQL" }] }]
  assert.equal(questionText(one), "有问题问你：\n数据库：用哪个？\n  1. Postgres\n  2. MySQL\n回复「编号 答案」（可以回选项编号）")
  assert.deepEqual(questionAnswers(one, "2"), { answers: { q1: { answers: ["MySQL"] } } })
  assert.deepEqual(questionAnswers(one, "随便"), { answers: { q1: { answers: ["随便"] } } })
  const two = [...one, { id: "q2", question: "名字？", options: null }]
  assert.deepEqual(questionAnswers(two, "1\n小明"), { answers: { q1: { answers: ["Postgres"] }, q2: { answers: ["小明"] } } })
  assert.equal(questionAnswers(two, "1"), null)
  assert.equal(questionAnswers([], "x"), null)
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

// A stand-in for the desktop router + owner window on a private pipe.
function fakeDesktop({ owns, requests }) {
  const pipe = `\\\\.\\pipe\\wx-test-${crypto.randomBytes(4).toString("hex")}`
  const got = []
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0)
    const send = (o) => sock.write(frame(o))
    sock.on("data", (d) => {
      const r = unframe(Buffer.concat([buf, d]))
      buf = r.rest
      for (const m of r.msgs) {
        got.push(m)
        const reply = (extra) => send({ type: "response", requestId: m.requestId, method: m.method, ...extra })
        if (m.type === "broadcast" && m.method === "thread-stream-following-changed" && m.params.following)
          send({ type: "broadcast", method: "thread-stream-state-changed", version: 11, params: { conversationId: m.params.conversationId, hostId: "local", change: { type: "snapshot", revision: 1, conversationState: { requests } } } })
        if (m.type !== "request") continue
        if (m.method === "initialize") reply({ resultType: "success", handledByClientId: "me", result: { clientId: "me" } })
        else if (m.method === "thread-owner-discovery") reply(owns ? { resultType: "success", handledByClientId: "owner", result: {} } : { resultType: "error", error: "no-client-found" })
        else reply({ resultType: "success", handledByClientId: "owner", result: { ok: true, ...(m.method === "thread-follower-interrupt-turn" && { interruptedTurnId: "turn-9" }) } })
      }
    })
  })
  return new Promise((r) => server.listen(pipe, () => r({ pipe, got, close: () => server.close() })))
}

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
    assert.equal(b.reply("t1", "x"), null)
    await b.send("t1", "只回复：好的")
    assert.ok(b.running("t1"))
    assert.ok(fs.existsSync(bridgeMarker(dir, "t1")))
    // The fake asks a question, then a command approval, then sends its reply and completes.
    await until(() => pushed.length === 1)
    assert.equal(pushed[0][1], "question")
    assert.match(pushed[0][2], /^有问题问你：/)
    assert.equal(b.approve("t1", true), 0)
    assert.equal(b.reply("t1", "1"), "answered")
    await until(() => pushed.length === 2)
    assert.deepEqual(pushed[1], ["t1", "approval", "git push（推送）"])
    assert.equal(b.approve("t1", true), 1)
    await until(() => !b.running("t1"))
    assert.deepEqual(pushed[2], ["t1", "done", "好的"])
    assert.ok(!fs.existsSync(bridgeMarker(dir, "t1")))
    // The fake fails resume for this id, like a thread a terminal is writing.
    await assert.rejects(b.send("busy", "x"), /正在电脑上打开/)
    assert.equal(b.running("busy"), false)
    assert.equal(await b.create("C:\\x", "hi"), "new-thread")
    // Images and model go into turn/start; /stop interrupts the turn we started; /compact runs as its own turn.
    const of = (id) => pushed.filter((p) => p[0] === id)
    await b.send("echo", "看图", { images: ["C:\\a.png"], model: "m1" })
    await until(() => of("echo").length)
    assert.equal(of("echo")[0][1], "done")
    assert.deepEqual(JSON.parse(of("echo")[0][2]), { input: [{ type: "text", text: "看图", text_elements: [] }, { type: "localImage", path: "C:\\a.png" }], model: "m1" })
    assert.deepEqual((await b.models()).map((m) => m.model), ["m1"])
    assert.equal(await b.interrupt("slow"), false)
    await b.send("slow", "数到 300")
    assert.equal(await b.interrupt("slow"), true)
    await until(() => !b.running("slow"))
    assert.deepEqual(of("slow"), [], "an interrupted turn pushes nothing")
    await b.compact("t1")
    await until(() => of("t1").length === 4)
    assert.deepEqual(of("t1")[3], ["t1", "info", "上下文已压缩"])
  } finally {
    b.stop()
  }
  assert.ok(!fs.existsSync(bridgeMarker(dir, "new-thread")))
  fs.rmSync(dir, { recursive: true })
})
