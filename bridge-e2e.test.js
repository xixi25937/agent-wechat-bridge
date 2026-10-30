import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"
import { agent, fakeHistory, sqlite, user } from "./fake-history.js"
import { lockFile, readLock } from "./poll-lock.js"

// The warm Codex app-server, concurrent messages, history from the db and the wake-up path, against a fake iLink and the
// fake app-server. The state folder, CODEX_HOME and the pipe are our own: nothing here reaches WeChat, ~/.cli-bridge,
// ~/.codex or the Codex desktop.
const here = path.dirname(fileURLToPath(import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wx-bridge-"))
const home = path.join(tmp, "state")
const codexHome = path.join(tmp, "codex")
const proj = path.join(tmp, "proj")
for (const d of [home, codexHome, proj]) fs.mkdirSync(d)
const pids = path.join(tmp, "pids")

const polls = { n: 0, closed: 0, fail: 0, hold: 3000 } // getupdates requests, ones the client gave up, 500s to answer, long-poll length
const server = http.createServer((req, res) => {
  const chunks = []
  req.on("data", (c) => chunks.push(c))
  req.on("end", () => {
    const u = new URL(req.url, "http://x")
    if (u.pathname === "/ilink/bot/getupdates") {
      polls.n++
      if (polls.fail > 0) return (polls.fail--, (res.statusCode = 500), res.end("{}"))
      const t = setTimeout(() => res.end(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: "b" })), polls.hold)
      res.on("close", () => (clearTimeout(t), res.writableEnded || polls.closed++))
      return
    }
    res.end(JSON.stringify({ ret: 0 }))
  })
})
await new Promise((r) => server.listen(0, "127.0.0.1", r))
const port = server.address().port
after(() => (server.closeAllConnections(), server.close(), fs.rmSync(tmp, { recursive: true, force: true })))

Object.assign(process.env, {
  WECHAT_NOTIFY_DIR: home,
  WECHAT_NOTIFY_POLL: "0",
  WECHAT_NOTIFY_RETRY_MS: "10",
  WECHAT_NOTIFY_PIPE: `\\\\.\\pipe\\wx-bridge-test-missing-${process.pid}`,
  OPENCODE_SERVICE_FILE: path.join(tmp, "no-service.json"),
  CODEX_HOME: codexHome,
  WECHAT_NOTIFY_CODEX_CMD: JSON.stringify([process.execPath, path.join(here, "fake-app-server.js")]),
  FAKE_PID_FILE: pids,
})
fs.writeFileSync(path.join(home, "account.json"), JSON.stringify({ token: "tok", baseUrl: `http://127.0.0.1:${port}`, userId: "u1" }))
const stateFile = path.join(home, "opencode-wechat-notify.json")
const setState = (o) => fs.writeFileSync(stateFile, JSON.stringify(o))
const getState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"))
const NUMS = { "codex:later": 3, "codex:slow": 4, "codex:t1": 1 }

const ix = await import("./index.js")
const g = globalThis.__wechatBridge
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
const starts = () => (fs.existsSync(pids) ? fs.readFileSync(pids, "utf8").trim().split("\n").filter(Boolean).map(Number) : [])
// A fresh bridge: the app-server a test started before is stopped and forgotten.
const resetBridge = () => {
  g.bridge?.stop()
  g.bridge = null
  fs.rmSync(pids, { force: true })
}
let seq = 0
const fromUser = (body, ctx = "c1") => ({
  message_id: `m${++seq}`, message_type: 1, from_user_id: "u1", context_token: ctx, create_time_ms: Date.now(),
  item_list: [{ type: 1, text_item: { text: body } }],
})
// Sends a message through inbound; `got` collects the replies with the time they came.
const ask = (body) => {
  const t0 = Date.now()
  const got = []
  const done = ix.inbound(fromUser(body), () => 0, async (t) => void got.push({ t, ms: Date.now() - t0, at: Date.now() }))
  return { got, done }
}
const log = () => (fs.existsSync(path.join(home, "wechat-notify.log")) ? fs.readFileSync(path.join(home, "wechat-notify.log"), "utf8") : "")

test("pollDelay is capped at 30 s", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9, 50, 1000].map(ix.pollDelay), [2000, 4000, 8000, 16000, 30_000, 30_000, 30_000, 30_000, 30_000])
})

test("wakeWatch: a gap of more than 2 minutes between ticks is a wake-up", () => {
  let t = 1_000_000
  const calls = []
  const w = ix.wakeWatch((ms) => calls.push(ms), { now: () => t, every: 1e9 })
  for (const step of [30_000, 30_000, 119_000, 120_000]) (t += step, w.tick())
  assert.deepEqual(calls, [], "30 s ticks, and up to exactly 2 minutes, are not sleep")
  t += 121_000
  w.tick()
  t += 30_000
  w.tick()
  assert.deepEqual(calls, [121_000], "reported once, then ticking normally again")
  w()
})

test("scheduler: one lane in order, lanes side by side, a global job waits for and holds back the rest", async () => {
  const s = ix.scheduler(1000)
  const events = []
  const job = (name, ms, lane) => s.submit(() => ({ lane, run: async () => (events.push(`+${name}`), await nap(ms), events.push(`-${name}`), name) }))
  const all = [job("a1", 80, "A"), job("a2", 5, "A"), job("b1", 20, "B"), job("g", 10, null), job("c1", 5, "C"), job("a3", 5, "A")]
  assert.deepEqual(await Promise.all(all), ["a1", "a2", "b1", "g", "c1", "a3"])
  const at = (e) => events.indexOf(e)
  assert.ok(at("+a1") < at("+b1") && at("+b1") < at("-a1"), "A and B ran side by side")
  assert.ok(at("-a1") < at("+a2") && at("-a2") < at("+a3"), "A ran in order")
  assert.ok(at("-b1") < at("-a1"), "B was not held up by A's slow job")
  assert.ok(at("-a2") < at("+g") && at("-b1") < at("+g"), "the global job waited for everything before it")
  assert.ok(at("-g") < at("+c1") && at("-g") < at("+a3"), "and held back everything after it")
  // plan() runs in message order, a null plan is a no-op, a throwing plan only fails its own message.
  const order = []
  const r = await Promise.allSettled([
    s.submit(() => (order.push(1), null)),
    s.submit(() => { throw new Error("bad") }),
    s.submit(() => (order.push(3), { lane: "A", run: async () => 3 })),
  ])
  assert.deepEqual(order, [1, 3])
  assert.deepEqual(r.map((x) => x.status), ["fulfilled", "rejected", "fulfilled"])
  // A job that never ends cannot make the bridge deaf: the global job goes ahead after waitMs.
  const stuck = ix.scheduler(60)
  stuck.submit(() => ({ lane: "X", run: () => new Promise(() => {}) }))
  const t0 = Date.now()
  await stuck.submit(() => ({ lane: null, run: async () => {} }))
  assert.ok(Date.now() - t0 >= 50 && Date.now() - t0 < 1000)
})

test("laneOf: quick commands, conversations, and the global ones; a numbered message becomes the target", () => {
  setState({ nums: { ...NUMS, "oc-session": 7 }, contextToken: "c1" })
  const lane = (t, media) => ix.laneOf(ix.parseCommand(t), media)
  for (const t of ["帮助", "列表", "额度", "帮助 列表", "3 帮助", "?"]) assert.equal(lane(t), "·quick", t)
  assert.equal(lane("目录"), "·dir")
  assert.equal(lane("目录 2"), "·dir")
  for (const t of ["/stop", "/start", "新对话 hi", "停止服务"]) assert.equal(lane(t), null, t)
  assert.equal(lane("看一下", true), null, "a message with media")
  assert.equal(lane("实时 关"), "·misc")
  assert.equal(lane("3 你好"), "codex:later")
  assert.equal(getState().target, "codex:later")
  assert.equal(lane("再来一条"), "codex:later", "unnumbered follows the target")
  assert.equal(lane("7 hi"), "oc-session")
  assert.equal(lane("再来一条"), "oc-session")
  assert.equal(lane("3 y"), "codex:later")
  assert.equal(lane("3 历史"), "codex:later")
  assert.equal(lane("9 hi"), "·misc", "no such number")
})

test("a slow Codex send does not hold up 帮助, 列表 or 额度, and one conversation stays in order", async () => {
  resetBridge()
  process.env.FAKE_INIT_MS = "700" // the cold app-server takes this long to start
  try {
    setState({ nums: NUMS, contextToken: "c1" })
    const a1 = ask("3 第一条")
    const a2 = ask("3 第二条")
    const quick = [ask("帮助"), ask("额度"), ask("列表")]
    await Promise.all(quick.map((q) => q.done))
    for (const q of quick) assert.ok(q.got.length && q.got[0].ms < 500, `answered at once: ${q.got[0]?.ms} ms`)
    assert.equal(a1.got.length, 0, "the send is still waiting for the app-server")
    await Promise.all([a1.done, a2.done])
    assert.match(a1.got[0].t, /^已发给 \[3\]/)
    assert.match(a2.got[0].t, /^已发给 \[3\]/)
    assert.ok(a1.got[0].ms >= 600, "it did wait")
    assert.ok(a1.got[0].at <= a2.got[0].at, "the second message of the conversation came after the first")
    assert.equal(starts().length, 1)
  } finally {
    delete process.env.FAKE_INIT_MS
  }
})

test("daemon: the lock holder keeps the app-server up; /stop closes it (after a running reply), /start opens it, losing the lock closes it", async () => {
  resetBridge()
  process.env.FAKE_TURN_MS = "1200"
  setState({ nums: NUMS, contextToken: "c1", paused: true })
  const quit = ix.runDaemon({ log: () => {}, lock: { beatMs: 40, standbyMs: 40 } })
  try {
    assert.equal(readLock(home).pid, process.pid)
    await nap(300)
    assert.equal(starts().length, 0, "paused: not started")
    // /start: the app-server starts without any Codex message.
    await ask("/start").done
    assert.equal(getState().paused, undefined)
    await wait(() => starts().length === 1)
    const [p1] = starts()
    assert.ok(alive(p1))
    // A reply of ours is running: /stop says it waits, and doesn't kill it.
    const send = ask("3 你好")
    await send.done
    assert.match(send.got[0].t, /^已发给 \[3\]/)
    assert.ok(g.bridge.running("later"))
    const stop = ask("/stop")
    await stop.done
    assert.equal(stop.got[0].t, ix.pausedText("later"))
    assert.match(stop.got[0].t, /^已暂停：.*Codex 后台程序等正在跑的回复结束后关闭。发 \/start 恢复$/)
    assert.equal(getState().paused, true)
    await nap(300)
    assert.ok(alive(p1), "not killed mid-turn")
    await wait(() => !alive(p1), 8000)
    assert.equal(starts().length, 1)
    // /start opens it again; /stop with nothing running closes it at once.
    await ask("/start").done
    await wait(() => starts().length === 2)
    const [, p2] = starts()
    await wait(() => alive(p2))
    const stop2 = ask("/stop")
    await stop2.done
    assert.equal(stop2.got[0].t, ix.pausedText("closed"))
    assert.match(stop2.got[0].t, /Codex 后台程序也关闭/)
    await wait(() => !alive(p2))
    // Not paused, but the lock goes to another process: back to on demand.
    await ask("/start").done
    await wait(() => starts().length === 3)
    const [, , p3] = starts()
    fs.writeFileSync(lockFile(home), JSON.stringify({ pid: process.pid + 1, host: "elsewhere", beat: Date.now() }))
    await wait(() => !alive(p3), 3000)
    assert.equal(g.poller, null)
    await nap(150)
    assert.equal(starts().length, 3, "nothing keeps it up any more")
    // Without a warm server, the first message starts one on demand like before.
    assert.equal(ix.pausedText(""), ix.PAUSED_TEXT)
  } finally {
    quit(false)
    delete process.env.FAKE_TURN_MS
    fs.rmSync(lockFile(home), { force: true })
  }
})

test("wake-up: the lock beat is renewed, the long poll is redone, a lost app-server comes back at once", async () => {
  resetBridge()
  let now = Date.now()
  polls.n = polls.closed = 0
  setState({ nums: NUMS, contextToken: "c1" })
  const quit = ix.runDaemon({ log: () => {}, lock: { beatMs: 60_000 }, wake: { now: () => now, every: 20 } })
  try {
    await wait(() => starts().length === 1 && polls.n === 1)
    const [p1] = starts()
    process.kill(p1)
    await wait(() => !alive(p1))
    await nap(100)
    assert.equal(starts().length, 1, "the restart waits 5 s on its own")
    fs.writeFileSync(lockFile(home), JSON.stringify({ pid: process.pid, host: os.hostname(), beat: Date.now() - 600_000 }))
    const t0 = Date.now()
    now += 3 * 60_000 // the machine slept
    await wait(() => starts().length === 2 && polls.n === 2, 3000)
    assert.ok(Date.now() - t0 < 2000, "all at once, not after the 5 s restart wait or the long poll")
    assert.equal(polls.closed, 1, "the poll in flight was given up")
    assert.ok(Date.now() - readLock(home).beat < 5000, "the beat was renewed")
    assert.match(log(), /wake: the computer was asleep for about 180 s/)
  } finally {
    quit(false)
    fs.rmSync(lockFile(home), { force: true })
  }
})

test("poll: a kick ends the wait after a failure and the long poll in flight, and forgets the failures", async () => {
  await nap(100) // the previous test's poller was aborted just now: let the fake see its connection close
  polls.n = polls.closed = 0
  polls.fail = 2
  const ac = new AbortController()
  const ctl = {}
  const seen = []
  const p = ix.poll(ac.signal, ctl, (fails) => (seen.push(fails), 60_000))
  try {
    await wait(() => seen.length === 1)
    ctl.kick()
    await wait(() => seen.length === 2)
    assert.deepEqual(seen, [0, 0], "the second failure counts as the first")
    ctl.kick()
    await wait(() => polls.n === 3)
    const t0 = Date.now()
    ctl.kick() // the third request is a long poll still waiting
    await wait(() => polls.n === 4, 1000)
    assert.ok(Date.now() - t0 < 500)
    assert.equal(polls.closed, 1)
  } finally {
    ac.abort()
    await p
  }
})

test("N and N 历史 read the history db when it is complete, app-server when it is not or our own turn runs", { skip: !sqlite }, async () => {
  const rollout = path.join(tmp, "rollout.jsonl")
  fs.writeFileSync(rollout, "x".repeat(1000))
  const st = new sqlite.DatabaseSync(path.join(codexHome, "state_5.sqlite"))
  st.exec("create table threads (id text primary key, rollout_path text, name text, title text, cwd text, model text)")
  for (const id of ["t1", "slow"]) st.prepare("insert into threads values (?, ?, ?, ?, ?, ?)").run(id, rollout, "示例", "示例", proj, "m1")
  st.close()
  const items = []
  for (const id of ["t1", "slow"]) {
    items.push([id, 1, user("u1", "第一问"), "turn1"], [id, 2, agent("a1", "第一答"), "turn1"])
    items.push([id, 3, user("u2", "第二问"), "turn2"], [id, 4, { type: "commandExecution", id: "c1" }, "turn2"], [id, 5, agent("a2", "第二答"), "turn2"])
  }
  fs.copyFileSync(fakeHistory(items), path.join(codexHome, "thread_history_1.sqlite"))
  resetBridge()
  setState({ nums: NUMS, contextToken: "c1" })
  // Complete db: answered without an app-server.
  const show = await ix.run({ type: "show", n: 1 })
  assert.ok(show.includes("第二答") && !show.includes("第一答"), show)
  const hist = (await ix.run({ type: "history", n: 1, count: 5 })).join("\n")
  for (const want of ["你：\n\n第一问", "AI：\n\n第一答", "你：\n\n第二问", "AI：\n\n第二答", "调用了 shell"]) assert.ok(hist.includes(want), `${want} in ${hist}`)
  assert.equal(starts().length, 0, "no app-server was started for either")
  // The rollout file grew past what the db has seen: ask app-server (the fake knows no turns, so nothing comes back).
  fs.writeFileSync(rollout, "x".repeat(1001))
  assert.match(await ix.run({ type: "show", n: 1 }), /还没有回复/)
  assert.equal(starts().length, 1, "app-server was asked")
  // Our own turn runs in the thread: app-server, even though the db looks complete.
  fs.writeFileSync(rollout, "x".repeat(1000))
  assert.ok((await ix.run({ type: "show", n: 4 })).includes("第二答"))
  assert.match(await ix.run({ type: "text", n: 4, text: "数到 300" }), /^已发给 \[4\]/)
  assert.match(await ix.run({ type: "show", n: 4 }), /还没有回复/)
  assert.match(await ix.run({ type: "slash", n: 4, name: "stop", args: "" }), /^已停止/)
  await wait(() => !g.bridge.running("slow"))
  assert.ok((await ix.run({ type: "show", n: 4 })).includes("第二答"), "idle again: the db")
  resetBridge()
})

test("帮助 and the pause reply say what /stop and /start do to the Codex background program", () => {
  assert.ok(ix.HELP.includes("- 也关掉 Codex 后台程序") && ix.HELP.includes("- /start → 恢复并重新打开"))
  assert.equal(ix.pausedText("closed"), "已暂停：不再推送，也不执行微信命令，Codex 后台程序也关闭。发 /start 恢复")
  assert.equal(ix.pausedText("later"), "已暂停：不再推送，也不执行微信命令，Codex 后台程序等正在跑的回复结束后关闭。发 /start 恢复")
  assert.equal(ix.pausedText(""), ix.PAUSED_TEXT)
})
