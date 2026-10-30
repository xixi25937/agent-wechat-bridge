import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"

import { LOW } from "./quota.js"

// A fake iLink that, like the real one, answers ret=-2 "prepare failed" once a context_token has carried 10 bot
// messages, plus a fake CDN for uploads. The state folder is our own: nothing here reaches WeChat or ~/.cli-bridge.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wx-quota-"))
const home = path.join(tmp, "state")
const proj = path.join(tmp, "proj")
const codexHome = path.join(tmp, "codex")
for (const d of [home, proj, codexHome]) fs.mkdirSync(d)

const LIMIT = 10
const used = {} // context_token -> messages the fake accepted
const accepted = [] // { ctx, item } in arrival order
const refused = [] // sendmessage answered with ret=-2
const calls = [] // every request path
let refuseAll = false
const server = http.createServer((req, res) => {
  const chunks = []
  req.on("data", (c) => chunks.push(c))
  req.on("end", () => {
    const u = new URL(req.url, "http://x")
    calls.push(u.pathname)
    if (u.pathname === "/ilink/bot/getuploadurl") return res.end(JSON.stringify({ ret: 0, upload_param: "UP" }))
    if (u.pathname === "/c2c/upload") return (res.setHeader("x-encrypted-param", "DL"), res.end("{}"))
    if (u.pathname !== "/ilink/bot/sendmessage") return (res.statusCode = 404, res.end())
    const msg = JSON.parse(Buffer.concat(chunks).toString()).msg
    const n = used[msg.context_token] ?? 0
    if (refuseAll || n >= LIMIT) return (refused.push(msg), res.end(JSON.stringify({ ret: -2, errmsg: "prepare failed" })))
    used[msg.context_token] = n + 1
    accepted.push({ ctx: msg.context_token, item: msg.item_list[0] })
    res.end(JSON.stringify({ ret: 0 }))
  })
})
await new Promise((r) => server.listen(0, "127.0.0.1", r))
const port = server.address().port
after(() => (server.closeAllConnections(), server.close(), fs.rmSync(tmp, { recursive: true, force: true })))

Object.assign(process.env, {
  WECHAT_NOTIFY_DIR: home,
  WECHAT_NOTIFY_CDN: `http://127.0.0.1:${port}/c2c`,
  WECHAT_NOTIFY_RETRY_MS: "10",
  WECHAT_NOTIFY_POLL: "0",
  OPENCODE_SERVICE_FILE: path.join(tmp, "no-service.json"),
  CODEX_HOME: codexHome,
})
fs.writeFileSync(path.join(home, "account.json"), JSON.stringify({ token: "tok", baseUrl: `http://127.0.0.1:${port}`, userId: "u1" }))
const stateFile = path.join(home, "opencode-wechat-notify.json")
const setState = (o) => fs.writeFileSync(stateFile, JSON.stringify(o))
const getState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"))
const text = (a) => a.item.text_item?.text
const texts = (ctx) => accepted.filter((a) => a.ctx === ctx).map(text)

const ix = await import("./index.js")
const hook = path.join(path.dirname(fileURLToPath(import.meta.url)), "codex-hook.js")
const report = path.join(proj, "report.pdf")
fs.writeFileSync(report, Buffer.alloc(2048, "x"))
// What the user's message looks like to getupdates.
let seq = 0
const fromUser = (ctx, body) => ({
  message_id: `m${++seq}`, message_type: 1, from_user_id: "u1", context_token: ctx, create_time_ms: Date.now(),
  item_list: [{ type: 1, text_item: { text: body } }],
})

test("e2e: 10 sends per token; low priority goes first, the notice takes the last, the rest is queued", async () => {
  setState({ nums: {}, contextToken: "ctx1" })
  // Progress (low priority) is fine while 4 or more sends are left: 7 of them.
  for (let i = 1; i <= 7; i++) assert.notEqual(await ix.send(`进度 ${i}`, LOW), "skipped", `progress ${i}`)
  assert.equal(accepted.length, 7)
  assert.equal(getState().sent, 7)
  // The 8th would eat into the reserve: dropped without reaching iLink.
  assert.equal(await ix.send("进度 8", LOW), "skipped")
  assert.equal(accepted.length, 7)
  // The reserve is for what matters.
  assert.match(await ix.send("等你批准 A"), /ret=0/)
  assert.match(await ix.send("最终回复 F"), /ret=0/)
  assert.equal(getState().sent, 9)
  // The 10th send is the notice, not the message: the message waits in the outbox.
  assert.equal(await ix.send("出错了 E"), "queued")
  assert.equal(accepted.length, 10)
  assert.equal(text(accepted.at(-1)), "额度用完了：还有 1 条没发，回任意一句话就补发")
  assert.equal(getState().sent, 10)
  assert.deepEqual(getState().outbox.map((e) => e.text), ["出错了 E"])
  // From here on nothing is sent, and nothing is dropped (text and files both queue, one notice only).
  assert.equal(await ix.send("以后的 L"), "queued")
  const uploads = calls.filter((c) => c === "/ilink/bot/getuploadurl").length
  assert.equal(await ix.sendFile(report), "queued")
  assert.equal(calls.filter((c) => c === "/ilink/bot/getuploadurl").length, uploads, "a queued file is not uploaded yet")
  assert.equal(accepted.length, 10)
  assert.equal(refused.length, 0, "the bridge never ran into ret=-2: its own count stopped it")
  assert.deepEqual(getState().outbox.map((e) => e.text ?? e.as), ["出错了 E", "以后的 L", "file"])
  assert.equal(await ix.run({ type: "quota" }), "已用 10/10，队列里 3 条")
})

test("e2e: the Codex hook process queues instead of dropping", () => {
  const payload = path.join(tmp, "stop.json")
  fs.writeFileSync(payload, JSON.stringify({ session_id: "t-hook", cwd: proj, last_assistant_message: "钩子进程的回复 H" }))
  const r = spawnSync(process.execPath, [hook, "stop-send", payload], { env: process.env, encoding: "utf-8", timeout: 30_000 })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /Stop \[\d+\] queued/)
  assert.equal(accepted.length, 10, "the hook process sent nothing to iLink")
  assert.equal(refused.length, 0)
  const q = getState().outbox
  assert.equal(q.length, 4)
  assert.ok(q.at(-1).text.includes("钩子进程的回复 H"))
  assert.equal(getState().sent, 10, "the hook process shares the count")
})

test("e2e: the next message from the user flushes the queue first, in order, texts merged", async () => {
  await ix.inbound(fromUser("ctx2", "额度"), () => 0)
  const got = texts("ctx2")
  assert.equal(got.length, 4, JSON.stringify(got))
  // Two consecutive texts became one message; the file keeps its place; the hook's reply follows.
  assert.ok(got[0].indexOf("出错了 E") >= 0 && got[0].indexOf("以后的 L") > got[0].indexOf("出错了 E"), got[0])
  assert.equal(accepted.filter((a) => a.ctx === "ctx2")[1].item.type, 4, "the file is the second message")
  assert.equal(got[1], undefined, "a file item has no text")
  assert.ok(got[2].includes("钩子进程的回复 H"))
  // The reply to the user's own message comes last and counts what the flush used.
  assert.equal(got[3], "已用 3/10，队列里 0 条")
  const s = getState()
  assert.equal(s.outbox, undefined)
  assert.equal(s.noticed, undefined)
  assert.equal(s.contextToken, "ctx2")
  assert.equal(s.sent, 4)
  assert.equal(refused.length, 0)
})

test("e2e: iLink says ret=-2 although we counted less: believed, queued, sent after the next message", async () => {
  refuseAll = true
  assert.equal(await ix.send("没想到满了 S"), "queued")
  refuseAll = false
  assert.ok(refused.length >= 2, "tried, waited, tried again")
  assert.equal(getState().sent, 10)
  assert.deepEqual(getState().outbox.map((e) => e.text), ["没想到满了 S"])
  await ix.inbound(fromUser("ctx3", "额度"), () => 0)
  assert.deepEqual(texts("ctx3"), ["没想到满了 S", "已用 1/10，队列里 0 条"])
})

test("e2e: the final reply is one message; the file offer rides in its last chunk", async () => {
  setState({ nums: {}, contextToken: "ctx4" })
  await ix.pushFinal("codex:f1", "[1] 最终 F", { images: [], reply: "没有文件", dir: proj, edited: [] })
  assert.deepEqual(texts("ctx4"), ["[1] 最终 F"], "no offer: the text goes out as it is")
  await ix.pushFinal("codex:f1", "[1] 最终 G", { images: [], reply: "写好了 report.pdf", dir: proj, edited: [] })
  const got = texts("ctx4")
  assert.equal(got.length, 2, "text and offer in one send")
  assert.ok(got[1].startsWith("[1] 最终 G\n\n") && got[1].includes("report.pdf"), got[1])
  assert.equal(getState().sent, 2)
})

// --- /stop and /start ---

const queued = (...t) => t.map((x, i) => ({ id: `q${i}`, at: Date.now(), text: x }))
const pending = path.join(home, "codex-pending")
// Async: the fake iLink lives in this process, so a blocking spawn would starve it.
const hookRun = (args, payload) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, [hook, ...args], { env: { ...process.env, CODEX_WECHAT_APPROVAL_TIMEOUT: "2" } })
    const r = { stdout: "", stderr: "" }
    c.stdout.on("data", (d) => (r.stdout += d))
    c.stderr.on("data", (d) => (r.stderr += d))
    c.on("close", (status) => resolve({ ...r, status }))
    c.stdin.end(payload ? JSON.stringify(payload) : "")
  })
const replies = async (ctx, body) => {
  const out = []
  await ix.inbound(fromUser(ctx, body), () => 0, async (t) => void out.push(t))
  return out
}

test("paused: nothing is pushed or queued by any process, and the flag lives in the state file", async () => {
  setState({ nums: {}, contextToken: "ctxP", paused: true, outbox: queued("排队的 Q1", "排队的 Q2") })
  const before = accepted.length
  assert.equal(await ix.send("推送"), "paused")
  assert.equal(await ix.send("进度", LOW), "paused")
  const uploads = calls.filter((c) => c === "/ilink/bot/getuploadurl").length
  assert.equal(await ix.sendFile(report), "paused")
  assert.equal(await ix.pushFinal("codex:p1", "[1] 最终", { images: [], reply: "写好了 report.pdf", dir: proj, edited: [] }), "paused")
  assert.equal(calls.filter((c) => c === "/ilink/bot/getuploadurl").length, uploads)
  assert.equal(accepted.length, before)
  const s = getState()
  assert.equal(s.sent ?? 0, 0, "nothing was counted")
  assert.deepEqual(s.outbox.map((e) => e.text), ["排队的 Q1", "排队的 Q2"], "dropped, not queued; what was queued before stays")
  // Another process reads the same flag.
  const other = spawnSync(process.execPath, ["-e", "import('./index.js').then((m) => console.log(m.paused()))"], { env: process.env, encoding: "utf-8", cwd: path.dirname(hook) })
  assert.equal(other.stdout.trim(), "true")
})

test("paused: the Codex hooks do not wait for WeChat and send nothing", async () => {
  const before = accepted.length
  const perm = { session_id: "t-perm", cwd: proj, tool_name: "Bash", tool_input: { command: "ls" } }
  let t0 = Date.now()
  let r = await hookRun(["PermissionRequest"], perm)
  assert.equal(r.status, 0)
  assert.equal(r.stdout, "", "no decision: Codex shows its own prompt")
  assert.ok(Date.now() - t0 < 1800, `returned at once, not after the 2 s wait (${Date.now() - t0} ms)`)
  assert.equal(accepted.length, before)
  assert.ok(!fs.existsSync(pending) || fs.readdirSync(pending).length === 0, "no approval record waits for an answer")
  // Stop and the question hook return before they start anything.
  r = await hookRun(["Stop"], { session_id: "t-stop", cwd: proj, last_assistant_message: "不该推的回复" })
  assert.equal(r.status, 0)
  r = await hookRun(["PreToolUse"], { session_id: "t-q", cwd: proj, tool_name: "request_user_input", tool_input: {} })
  assert.equal(r.status, 0)
  assert.ok(!fs.existsSync(path.join(home, "codex-hook.log")), "no detached sender was started")
  // A sender that was already running when the pause came.
  const payload = path.join(tmp, "late.json")
  fs.writeFileSync(payload, JSON.stringify({ session_id: "t-late", cwd: proj, last_assistant_message: "来不及的回复" }))
  r = await hookRun(["stop-send", payload])
  assert.equal(r.stderr, "")
  assert.equal(accepted.length, before)
  assert.equal(getState().outbox.length, 2, "and nothing was queued")
  // Control: the same approval request without the pause does push and wait.
  const s = getState()
  delete s.paused
  s.pollerPid = process.pid
  setState(s)
  t0 = Date.now()
  r = await hookRun(["PermissionRequest"], perm)
  assert.equal(r.stdout, "")
  assert.ok(Date.now() - t0 >= 1900, "it waited for an answer")
  assert.equal(accepted.length, before + 1, `and pushed the request: ${r.stderr} ${Date.now() - t0} ms`)
  assert.ok(texts("ctxP").at(-1).includes("等你批准"))
  assert.equal(fs.readdirSync(pending).filter((f) => f.endsWith(".json")).length, 1)
})

test("paused: commands are ignored except /start, 帮助 and 额度", async () => {
  setState({ nums: {}, contextToken: "ctxP2", paused: true, outbox: queued("排队的 Q1", "排队的 Q2") })
  const before = accepted.length
  for (const t of ["列表", "3 内容", "3 /stop", "/model", "目录", "3 y", "你好", "开始吧", "实时 关", "图 a.png", "文件", "新对话 hi"]) {
    assert.deepEqual(await replies("ctxP2", t), [], t)
  }
  const image = { ...fromUser("ctxP2", ""), item_list: [{ type: 2, image_item: { media: { encrypt_query_param: "x" }, aes_key: "00" } }] }
  await ix.inbound(image, () => 0, async () => assert.fail("media is ignored while paused"))
  assert.equal(accepted.length, before)
  assert.equal(getState().paused, true)
  assert.deepEqual(await replies("ctxP2", "额度"), ["已用 0/10，队列里 2 条（已暂停）"])
  const help = (await replies("ctxP2", "帮助")).join("\n\n")
  assert.ok(help.includes("暂停服务") && help.includes("/start"))
  assert.equal(getState().outbox.length, 2, "no flush while paused")
  // A repeated /stop just confirms.
  assert.deepEqual(await replies("ctxP2", "/stop"), [ix.PAUSED_TEXT])
})

test("/stop pauses and persists, /start resumes and sends what queued up before; 3 /stop and 开始 keep their old meaning while running", async () => {
  setState({ nums: {}, contextToken: "ctxS" })
  // A numbered /stop is the conversation's: no pause, and no PAUSED_TEXT.
  const numbered = await replies("ctxS", "3 /stop")
  assert.ok(!numbered.includes(ix.PAUSED_TEXT) && getState().paused === undefined, JSON.stringify(numbered))
  // 「开始」 while running is an ordinary message for the agent.
  const word = await replies("ctxS", "开始")
  assert.ok(word.length && !word.some((t) => /已恢复|没有暂停/.test(t)), JSON.stringify(word))
  // /stop: the confirmation itself is sent (it answers the user), then the bridge is quiet.
  const n0 = accepted.length
  await ix.inbound(fromUser("ctxS", "/stop"), () => 0)
  assert.equal(texts("ctxS").at(-1), ix.PAUSED_TEXT)
  assert.equal(accepted.length, n0 + 1)
  assert.equal(getState().paused, true)
  assert.equal(await ix.send("x"), "paused")
  // What was queued before the pause stays; /start reports it and sends it after the 「已恢复」.
  const s = getState()
  s.outbox = queued("排队的 Q1", "排队的 Q2")
  setState(s)
  await ix.inbound(fromUser("ctxS2", "/start"), () => 0)
  const got = texts("ctxS2")
  assert.equal(got[0], "已恢复，队列里 2 条，接着补发")
  assert.equal(got.length, 2, "the two queued texts went out as one message")
  assert.ok(got[1].includes("排队的 Q1") && got[1].includes("排队的 Q2"))
  assert.equal(getState().paused, undefined)
  assert.equal(getState().outbox, undefined)
  assert.match(await ix.send("又能推了"), /ret=0/)
  // /start while running changes nothing; 「开始」 while paused resumes.
  assert.deepEqual(await replies("ctxS3", "/start"), ["没有暂停，一直在运行"])
  await replies("ctxS3", "停止服务")
  assert.equal(getState().paused, true)
  assert.deepEqual(await replies("ctxS3", "开始"), ["已恢复"])
  assert.equal(getState().paused, undefined)
})
