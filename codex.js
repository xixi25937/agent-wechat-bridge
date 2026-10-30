// Codex control for the WeChat bridge: the desktop's IPC pipe, and an app-server the plugin runs itself.
import { execFile, spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import { formAction, questionForm } from "./form.js"

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
export const PIPE = "\\\\.\\pipe\\codex-ipc"
const IDLE_MS = 10 * 60_000
export const BUSY = "该对话正在电脑上打开，请稍后或在电脑上操作"
// The desktop drops messages whose version differs from its own table (app.asar of Codex desktop 26.1023).
const VERSIONS = { initialize: 0, "thread-follower-start-turn": 2, "thread-follower-interrupt-turn": 4 }
const PERMS = "item/permissions/requestApproval"
const QUESTION = "item/tool/requestUserInput"
const DESKTOP = {
  "item/commandExecution/requestApproval": "thread-follower-command-approval-decision",
  "item/fileChange/requestApproval": "thread-follower-file-approval-decision",
  [PERMS]: "thread-follower-permissions-request-approval-response",
}
// Server requests a bridge turn holds until WeChat answers; anything else is refused at once.
const HELD = new Set([...Object.keys(DESKTOP), QUESTION])

export const cleanDir = (cwd) => String(cwd ?? "").replace(/^\\\\\?\\/, "")

export function codexHead(n, cwd, thread, { base, short }) {
  return `[${n}] Codex · ${base(cleanDir(cwd || thread?.cwd))} / ${short(thread?.name || thread?.title, 40) || "未命名会话"}`
}

// Present while a turn started from WeChat runs in our app-server; codex-hook.js then leaves approvals to us.
export const bridgeMarker = (dir, threadId) => path.join(dir, `bridge-${threadId}.run`)

// --- desktop IPC: each frame is a 4-byte little-endian length plus JSON ---

export function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj))
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length)
  return Buffer.concat([head, body])
}

export function unframe(buf) {
  const msgs = []
  let i = 0
  while (buf.length - i >= 4) {
    const n = buf.readUInt32LE(i)
    if (buf.length - i - 4 < n) break
    try {
      msgs.push(JSON.parse(buf.subarray(i + 4, i + 4 + n).toString("utf8")))
    } catch {}
    i += 4 + n
  }
  return { msgs, rest: buf.subarray(i) }
}

// A registered IPC client, or null when the desktop isn't running or doesn't answer.
export function ipcConnect(pipe = PIPE, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = net.connect(pipe)
    const waits = new Map()
    const listeners = new Set()
    let buf = Buffer.alloc(0)
    let clientId = null
    const write = (o) => sock.writable && sock.write(frame(o))
    sock.on("data", (d) => {
      const r = unframe(Buffer.concat([buf, d]))
      buf = r.rest
      for (const m of r.msgs) {
        if (m.type === "response") waits.get(m.requestId)?.(m)
        else if (m.type === "broadcast") for (const f of listeners) f(m)
        // The router asks every client whether it can handle a request; we never can.
        else if (m.type === "client-discovery-request")
          write({ type: "client-discovery-response", requestId: m.requestId, response: { canHandle: false } })
      }
    })
    sock.on("close", () => {
      for (const w of [...waits.values()]) w({ type: "response", resultType: "error", error: "connection-closed" })
    })
    const request = (method, params, ms = timeoutMs) =>
      new Promise((res, rej) => {
        const requestId = crypto.randomUUID()
        const t = setTimeout(() => (waits.delete(requestId), rej(new Error(`${method} 超时`))), ms)
        waits.set(requestId, (m) => (clearTimeout(t), waits.delete(requestId), res(m)))
        write({ type: "request", requestId, sourceClientId: clientId, version: VERSIONS[method] ?? 1, method, params, timeoutMs: ms })
      })
    const client = {
      request,
      broadcast: (method, params) => write({ type: "broadcast", method, sourceClientId: clientId, version: 1, params }),
      on: (f) => (listeners.add(f), () => listeners.delete(f)),
      close: () => sock.destroy(),
    }
    sock.on("error", () => resolve(null))
    sock.once("connect", () =>
      request("initialize", { clientType: "wechat-bridge" }).then(
        (r) => (r.resultType === "success" ? ((clientId = r.result?.clientId), resolve(client)) : (sock.destroy(), resolve(null))),
        () => (sock.destroy(), resolve(null)),
      ),
    )
  })
}

// Desktop client id that has the thread loaded, or null.
export async function ownerOf(ipc, threadId) {
  const r = await ipc.request("thread-owner-discovery", { hostId: "local", conversationId: threadId }).catch(() => null)
  return r?.resultType === "success" ? r.handledByClientId : null
}

export async function desktopOwns(threadId, pipe) {
  const ipc = await ipcConnect(pipe, 2000)
  try {
    return !!(ipc && (await ownerOf(ipc, threadId)))
  } finally {
    ipc?.close()
  }
}

// Follows the thread just long enough to get the owner's snapshot; pending server requests are in `requests`.
export async function desktopSnapshot(ipc, threadId, timeoutMs = 8000) {
  let off
  let timer
  const got = new Promise((resolve, reject) => {
    off = ipc.on((m) => {
      const p = m.params
      if (m.method === "thread-stream-state-changed" && p?.conversationId === threadId && p.change?.type === "snapshot")
        resolve(p.change.conversationState)
    })
    timer = setTimeout(() => reject(new Error("电脑上的 Codex 没有返回对话状态")), timeoutMs)
  })
  const follow = (following) => ipc.broadcast("thread-stream-following-changed", { conversationId: threadId, hostId: "local", following })
  follow(true)
  try {
    return await got
  } finally {
    clearTimeout(timer)
    off()
    follow(false)
  }
}

export const pendingApprovals = (state) => (state?.requests ?? []).filter((r) => DESKTOP[r.method])

// Response to an approval server request (app-server JSON-RPC result).
export function serverResponse(req, allow) {
  if (req.method === PERMS) {
    const granted = Object.fromEntries(Object.entries(req.params?.permissions ?? {}).filter(([, v]) => v != null))
    return { permissions: allow ? granted : {}, scope: "turn" }
  }
  return { decision: allow ? "accept" : "decline" }
}

// [ipc method, params] that answers a desktop approval, same shapes the desktop's own follower windows send.
export function decisionRequest(threadId, req, allow) {
  const r = serverResponse(req, allow)
  const answer = req.method === PERMS ? { response: r } : { decision: r.decision }
  return [DESKTOP[req.method], { conversationId: threadId, requestId: req.id, ...answer }]
}

// turn/start input: the text, then local image files (same shape the desktop sends for attached images).
export const turnInput = (text, images = []) => [{ type: "text", text, text_elements: [] }, ...images.map((p) => ({ type: "localImage", path: p }))]

export const startTurnParams = (threadId, text, { images, model } = {}) => ({
  conversationId: threadId,
  turnStart: { request: { threadId, input: turnInput(text, images), ...(model && { model }) }, context: {} },
})

// Answers the desktop's pending approvals of a thread (allow: the oldest, deny: all). Returns how many, or null when
// the desktop doesn't have the thread loaded.
export async function desktopApprove(threadId, allow, pipe) {
  const ipc = await ipcConnect(pipe)
  if (!ipc) return null
  try {
    if (!(await ownerOf(ipc, threadId))) return null
    const reqs = pendingApprovals(await desktopSnapshot(ipc, threadId))
    const picked = allow ? reqs.slice(0, 1) : reqs
    for (const r of picked) {
      const res = await ipc.request(...decisionRequest(threadId, r, allow))
      if (res.resultType !== "success") throw new Error(`电脑上的 Codex 拒绝了：${res.error}`)
    }
    return picked.length
  } finally {
    ipc.close()
  }
}

// Result of a request to the desktop window that has the thread loaded, or null when none has it.
async function desktopCall(threadId, method, params, pipe) {
  const ipc = await ipcConnect(pipe)
  if (!ipc) return null
  try {
    if (!(await ownerOf(ipc, threadId))) return null
    const r = await ipc.request(method, params, 30_000)
    if (r.resultType !== "success") throw new Error(`电脑上的 Codex 拒绝了：${r.error}`)
    return r.result ?? {}
  } finally {
    ipc.close()
  }
}

// Starts a turn in the desktop window; false when the desktop doesn't have the thread loaded.
export const desktopSend = async (threadId, text, pipe, opts) =>
  (await desktopCall(threadId, "thread-follower-start-turn", startTurnParams(threadId, text, opts), pipe)) != null

// Stops the window's running turn, like its stop button: the stopped turn id, "" when nothing ran, null when not loaded.
export async function desktopInterrupt(threadId, pipe) {
  const r = await desktopCall(threadId, "thread-follower-interrupt-turn", { conversationId: threadId, mode: "user-stop" }, pipe)
  return r == null ? null : (r.interruptedTurnId ?? "")
}

export const desktopCompact = async (threadId, pipe) =>
  (await desktopCall(threadId, "thread-follower-compact-thread", { conversationId: threadId }, pipe)) != null

// --- the plugin's own app-server (JSON-RPC, one JSON object per line over stdio) ---

// Newest codex.exe bundled with the desktop (its folder name changes on every update), else `codex` on PATH.
export function codexBin() {
  const root = path.join(process.env.LOCALAPPDATA ?? "", "OpenAI", "Codex", "bin")
  let best = null
  try {
    for (const d of fs.readdirSync(root)) {
      const f = path.join(root, d, "codex.exe")
      const st = fs.statSync(f, { throwIfNoEntry: false })
      if (st && (!best || st.mtimeMs > best.t)) best = { f, t: st.mtimeMs }
    }
  } catch {}
  return best?.f ?? "codex"
}

function appServer([cmd, ...args], onMessage) {
  const cp = spawn(cmd, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true })
  const waits = new Map()
  let id = 0
  const s = { dead: false, closing: false }
  const fail = (e) => {
    if (s.dead) return
    s.dead = true
    for (const w of waits.values()) w.reject(e)
    waits.clear()
    onMessage({ method: "bridge/exited" })
  }
  cp.on("error", fail)
  cp.on("exit", () => fail(new Error("Codex app-server 退出了")))
  cp.stdin.on("error", () => {})
  readline.createInterface({ input: cp.stdout }).on("line", (line) => {
    let m
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    if (m.id != null && !m.method) {
      const w = waits.get(m.id)
      waits.delete(m.id)
      if (m.error) w?.reject(new Error(m.error.message ?? "app-server error"))
      else w?.resolve(m.result)
    } else onMessage(m)
  })
  const write = (o) => !s.dead && !s.closing && cp.stdin.write(JSON.stringify(o) + "\n")
  s.call = (method, params) =>
    new Promise((resolve, reject) => {
      if (s.dead || s.closing) return reject(new Error("Codex app-server 没在运行"))
      waits.set(++id, { resolve, reject })
      write({ id, method, params })
    })
  s.respond = (rid, result) => write({ id: rid, result })
  s.refuse = (rid) => write({ id: rid, error: { code: -32601, message: "not handled by the WeChat bridge" } })
  // Closing stdin makes app-server exit; kill the tree if it is still there after 3 s (shell children).
  s.stop = () => {
    if (s.dead || s.closing) return
    s.closing = true
    cp.stdin.end()
    setTimeout(() => {
      if (cp.exitCode !== null || cp.signalCode !== null) return
      if (process.platform === "win32") execFile("taskkill", ["/pid", String(cp.pid), "/T", "/F"], { windowsHide: true }, () => {})
      else cp.kill()
    }, 3000).unref?.()
  }
  s.ready = s
    .call("initialize", {
      clientInfo: { name: "opencode-wechat-notify", title: null, version: "0.2.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    .then(() => write({ method: "initialized" }))
  return s
}

// requestUserInput result for the answers of questionForm(questions).
export const questionResult = (answers) => ({
  answers: Object.fromEntries(Object.entries(answers).map(([id, v]) => [id, { answers: [String(v)] }])),
})

// What an approval server request is for, one line.
export function approvalSummary(req) {
  const p = req.params ?? {}
  const reason = p.reason ? `（${p.reason}）` : ""
  if (req.method === "item/fileChange/requestApproval") return `改文件${p.grantRoot ? ` ${p.grantRoot}` : ""}${reason}`
  if (req.method === PERMS) return `更多权限 ${JSON.stringify(p.permissions ?? {})}${reason}`
  return `${p.command ?? "命令"}${reason}`
}

// Runs the turns WeChat starts on threads the desktop doesn't have loaded, and reports them itself through
// push(threadId, kind, text) with kind "approval" | "question" | "done" | "failed" | "info", plus "text" (a finished
// agent message), "tool" (a tool item's name) and "end" (an interrupted turn) for live progress: hooks may be
// untrusted for this app-server, and codex-hook.js skips threads with a bridge marker so nothing is pushed twice.
export function createBridge({ push, markerDir, bin = () => [codexBin(), "app-server"] }) {
  let server = null
  let idle = null
  const active = new Map() // threadId → held server requests, while a turn we started runs
  const turnIds = new Map() // threadId → id of the running turn we started
  const compacting = new Set()
  const setActive = (threadId) => {
    active.set(threadId, [])
    if (!markerDir) return
    fs.mkdirSync(markerDir, { recursive: true })
    fs.writeFileSync(bridgeMarker(markerDir, threadId), String(process.pid))
  }
  const clearActive = (threadId) => {
    active.delete(threadId)
    turnIds.delete(threadId)
    edits.delete(threadId)
    compacting.delete(threadId)
    if (markerDir) fs.rmSync(bridgeMarker(markerDir, threadId), { force: true })
  }
  const touch = () => {
    clearTimeout(idle)
    // ponytail: a turn stuck on an unanswered approval keeps app-server alive until answered or the plugin unloads.
    idle = setTimeout(() => (active.size ? touch() : b.stop()), IDLE_MS)
    idle.unref?.()
  }
  const edits = new Map() // threadId → completed fileChange items of the running turn
  const last = new Map() // threadId → newest agent message text of the running turn
  const onMessage = (m) => {
    if (m.method === "bridge/exited") return [...active.keys()].forEach(clearActive)
    const p = m.params ?? {}
    const held = active.get(p.threadId)
    if (m.id != null) {
      if (!held || !HELD.has(m.method)) return server?.refuse(m.id)
      held.push(m)
      // A question is pushed as its questions array; index.js formats it with the thread's number.
      push(p.threadId, m.method === QUESTION ? "question" : "approval", m.method === QUESTION ? p.questions ?? [] : approvalSummary(m))
      return
    }
    if (m.method === "turn/started" && held && p.turn?.id) turnIds.set(p.threadId, p.turn.id)
    if (m.method === "item/completed" && held && p.item?.type === "agentMessage" && p.item.text) {
      last.set(p.threadId, p.item.text)
      push(p.threadId, "text", p.item.text)
    }
    if (m.method === "item/completed" && held && p.item?.type === "fileChange") edits.set(p.threadId, [...(edits.get(p.threadId) ?? []), p.item])
    if (m.method === "item/started" && held && TOOL[p.item?.type]) push(p.threadId, "tool", TOOL[p.item.type](p.item))
    if (m.method === "serverRequest/resolved" && held) active.set(p.threadId, held.filter((r) => r.id !== p.requestId))
    if (m.method === "turn/completed" && held) {
      const compacted = compacting.has(p.threadId)
      const fileChanges = edits.get(p.threadId) ?? []
      clearActive(p.threadId)
      const reply = last.get(p.threadId) ?? ""
      last.delete(p.threadId)
      if (p.turn?.status === "failed") push(p.threadId, "failed", p.turn.error?.message ?? "未知错误")
      else if (p.turn?.status === "completed") push(p.threadId, compacted ? "info" : "done", compacted ? "上下文已压缩" : reply, ...(fileChanges.length && !compacted ? [{ fileChanges }] : []))
      else push(p.threadId, "end", "")
      server?.call("thread/unsubscribe", { threadId: p.threadId }).catch(() => {})
      touch()
    }
  }
  const ensure = async () => {
    if (!server || server.dead || server.closing) server = appServer(bin(), onMessage)
    const s = server
    await s.ready
    touch()
    return s
  }
  const turnParams = (threadId, text, { images, model } = {}) => ({ threadId, input: turnInput(text, images), ...(model && { model }) })
  const startTurn = async (s, threadId, text, opts) => {
    setActive(threadId)
    try {
      const r = await s.call("turn/start", turnParams(threadId, text, opts))
      if (r?.turn?.id && !turnIds.has(threadId)) turnIds.set(threadId, r.turn.id)
    } catch (e) {
      clearActive(threadId)
      s.call("thread/unsubscribe", { threadId }).catch(() => {})
      throw e
    }
  }
  // One writer per thread: resume fails while a terminal or the desktop is running it.
  const resume = (s, threadId) =>
    s.call("thread/resume", { threadId, excludeTurns: true }).catch((e) => {
      throw /writer/i.test(e.message) ? new Error(BUSY) : e
    })
  const take = (threadId, question) => (active.get(threadId) ?? []).filter((r) => (r.method === QUESTION) === question)
  const answer = (threadId, req, result) => {
    server?.respond(req.id, result)
    if (active.has(threadId)) active.set(threadId, active.get(threadId).filter((r) => r !== req))
  }
  const b = {
    running: (threadId) => active.has(threadId),
    // opts: { images: [absolute paths], model }.
    async send(threadId, text, opts) {
      const s = await ensure()
      // Our turn is still running: turn/start adds the text to it.
      if (active.has(threadId)) return void (await s.call("turn/start", turnParams(threadId, text, opts)))
      await resume(s, threadId)
      await startTurn(s, threadId, text, opts)
    },
    async create(cwd, text, opts) {
      const s = await ensure()
      // Without threadSource "user" the desktop app leaves the thread out of its sidebar (every listed thread has it).
      const { thread } = await s.call("thread/start", { cwd, threadSource: "user" })
      await startTurn(s, thread.id, text, opts)
      return thread.id
    },
    // Stops our running turn of the thread; false when none runs here.
    async interrupt(threadId) {
      const turnId = turnIds.get(threadId)
      if (!active.has(threadId) || !turnId) return false
      await (await ensure()).call("turn/interrupt", { threadId, turnId })
      return true
    },
    // Compaction runs as a turn of its own; its completion is pushed as "info".
    async compact(threadId) {
      if (active.has(threadId)) throw new Error("这个对话正在运行，等它结束再压缩")
      const s = await ensure()
      await resume(s, threadId)
      setActive(threadId)
      compacting.add(threadId)
      try {
        await s.call("thread/compact/start", { threadId })
      } catch (e) {
        clearActive(threadId)
        s.call("thread/unsubscribe", { threadId }).catch(() => {})
        throw e
      }
    },
    // Drops turn `turnId` and every later one from the thread's history; files are not touched (see ThreadRevertParams).
    async revert(threadId, turnId) {
      if (active.has(threadId)) throw new Error("这个对话正在运行，先停止再撤回")
      const s = await ensure()
      await resume(s, threadId)
      try {
        await s.call("thread/revert", { threadId, beforeTurnId: turnId })
      } finally {
        s.call("thread/unsubscribe", { threadId }).catch(() => {})
      }
    },
    async models() {
      const s = await ensure()
      return (await s.call("model/list", {})).data ?? []
    },
    // Newest first.
    async turns(threadId, limit) {
      const s = await ensure()
      try {
        return (await s.call("thread/turns/list", { threadId, limit, sortDirection: "desc", itemsView: "full" })).data ?? []
      } catch {
        // Legacy (non-paginated) threads.
        const { thread } = await s.call("thread/read", { threadId, includeTurns: true })
        return (thread.turns ?? []).slice(-limit).reverse()
      }
    },
    // Approvals held by a running bridge turn: allow answers the oldest, deny all. Returns how many.
    approve(threadId, allow) {
      const reqs = take(threadId, false)
      const picked = allow ? reqs.slice(0, 1) : reqs
      for (const r of picked) answer(threadId, r, serverResponse(r, allow))
      return picked.length
    },
    // WeChat text for the oldest held question: one line per question at once, or one per message (progress stays
    // on the held request). Returns the reply ("已回答 [n]" once answered), or null when no question is waiting.
    // `tag`: how the reply names the conversation, e.g. "[4] Codex · proj".
    reply(threadId, text, n, tag = `[${n}]`) {
      const q = take(threadId, true)[0]
      if (!q) return null
      const form = { id: q.id, ...questionForm(q.params?.questions) }
      const a = formAction(form, q.progress, text, n, { cancel: false, tag })
      if (a.save) q.progress = a.save
      if (a.reply) return a.reply
      answer(threadId, q, questionResult(a.submit))
      return `已回答 ${tag}`
    },
    stop() {
      clearTimeout(idle)
      ;[...active.keys()].forEach(clearActive)
      server?.stop()
      server = null
    },
  }
  return b
}

// --- state db and history ---

async function query(sql, ...args) {
  try {
    const { DatabaseSync } = await import("node:sqlite")
    const db = new DatabaseSync(path.join(CODEX_HOME, "state_5.sqlite"), { readOnly: true })
    try {
      return db.prepare(sql).all(...args)
    } finally {
      db.close()
    }
  } catch {
    return []
  }
}

// Non-archived threads the user started (subagents and auto-reviewers excluded).
const USER_THREADS = "archived = 0 and coalesce(thread_source, 'user') = 'user' and source not like '%subagent%'"

export const codexThread = async (id) => (await query("select name, title, cwd, model from threads where id = ?", id))[0] ?? null

export const codexThreads = ({ cwd, limit = 10 } = {}) =>
  query(
    `select id, name, title, cwd, updated_at_ms as updated from threads where ${USER_THREADS}` +
      `${cwd ? " and lower(cwd) in (lower(?), lower(?))" : ""} order by updated_at_ms desc limit ?`,
    ...(cwd ? [cwd, `\\\\?\\${cwd}`] : []),
    limit,
  )

export async function codexDirs(limit = 15) {
  const rows = await query(`select cwd, max(updated_at_ms) as updated from threads where ${USER_THREADS} group by cwd order by updated desc`)
  const seen = new Map()
  for (const r of rows) {
    const cwd = cleanDir(r.cwd)
    if (cwd && !seen.has(cwd.toLowerCase()) && fs.existsSync(cwd)) seen.set(cwd.toLowerCase(), { cwd, updated: r.updated })
  }
  return [...seen.values()].slice(0, limit)
}

const TOOL = {
  commandExecution: () => "shell",
  fileChange: () => "改文件",
  mcpToolCall: (i) => `${i.server}.${i.tool}`,
  dynamicToolCall: (i) => i.tool,
  webSearch: () => "web_search",
  imageGeneration: () => "生成图片",
  collabAgentToolCall: () => "子代理",
}

// Codex turns (newest first) as the OpenCode-shaped messages index.js formats, newest first.
export function codexMsgs(turns) {
  const out = []
  for (const t of [...(turns ?? [])].reverse())
    for (const i of t.items ?? []) {
      if (i.type === "userMessage")
        out.push({ type: "user", text: (i.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n") })
      else if (i.type === "agentMessage") out.push({ type: "assistant", content: [{ type: "text", text: i.text }] })
      else if (TOOL[i.type]) out.push({ type: "assistant", content: [{ type: "tool", name: TOOL[i.type](i) }] })
    }
  return out.reverse()
}
