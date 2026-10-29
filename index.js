import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

// session.idle exists in the client types but 2.0.32 never emits it; a finished run is session.execution.succeeded.
const TYPES = new Set(["session.execution.succeeded", "session.execution.failed", "permission.asked", "form.created"])
const DEBOUNCE_MS = 5000
const MAX_CHARS = 1500
const TAG = "[wechat-notify]"
export const DIR = process.env.WECHAT_NOTIFY_DIR || path.join(os.homedir(), ".cli-bridge")
const STATE_FILE = path.join(DIR, "opencode-wechat-notify.json")
// Codex approval handshake with codex-hook.js: <id>.json is the request, <id>.answer is "allow" or "deny".
export const PENDING_DIR = path.join(DIR, "codex-pending")
const CODEX_TODO = "Codex 对话暂不支持这个操作（下一步会加）"
const SERVICE_FILE = path.join(os.homedir(), ".local", "state", "opencode", "service.json")
const YES = /^(y|yes|是|批准|同意)$/i
const NO = /^(n|no|否|不|拒绝)$/i
const STATUS = { succeeded: "完成", failed: "出错", interrupted: "中断" }
const HELP = [
  "用法：",
  "3 内容 → 发给 [3] 号对话（有待回答的问题时作为回答）",
  "直接发内容 → 发给你上次用编号指定的对话（回复里会标明发给了几号）",
  "3 y / 3 n → 批准一次 / 拒绝 [3] 的权限请求",
  "3 → 再看一次 [3] 的最后回复",
  "3 历史 10 → [3] 最近 10 条消息（默认 5，最多 20）",
  "列表 → 最近的对话和编号",
  "目录 → 列出文件夹；目录 2 → 选中第 2 个文件夹并列出它的对话",
  "新对话 内容 → 在选中的文件夹里开新对话",
  "图 路径 → 把电脑上的图片发过来（相对路径按选中的文件夹算）",
  "Codex 对话（标着 Codex）目前只支持 3 y / 3 n",
].join("\n")
const IMG = /\.(png|jpe?g|gif|webp)$/i
const MAX_IMAGES = 4
const IMAGE_MAX_BYTES = 10 * 1024 * 1024
const TOO_BIG = "太大（超过 10 MB）"
const CDN = "https://novac2c.cdn.weixin.qq.com/c2c"

export const short = (s, n = 80) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim()
  return t.length > n ? t.slice(0, n - 1) + "…" : t
}
export const base = (dir) => (dir ? dir.split(/[\\/]/).filter(Boolean).pop() : "") || "?"
const toArr = (r) => (Array.isArray(r) ? r : (r?.data ?? []))
const warn = (...a) => console.warn(TAG, ...a.map((x) => short(x?.message ?? x, 200)))

export function clip(text, max = MAX_CHARS) {
  const t = String(text ?? "").trim()
  return t.length > max ? `${t.slice(0, max)}\n…（已截断，共 ${t.length} 字，完整内容看桌面端）` : t
}

export const head = (n, session, fallbackDir) =>
  `[${n}] ${base(session?.location?.directory ?? fallbackDir)} / ${short(session?.title, 40) || "未命名会话"}`

export function sessionIDOf(event) {
  return event?.data?.sessionID ?? event?.data?.form?.sessionID
}

// Text of the newest assistant message that has any; `msgs` is newest first. Stops at the run's user prompt.
export function replyText(msgs, stopAtUser = true) {
  for (const m of msgs ?? []) {
    if (stopAtUser && m.type === "user") break
    if (m.type !== "assistant") continue
    const t = (m.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim()
    if (t) return t
  }
  return ""
}

// One WeChat message per user / assistant message, oldest first, plus a closing line. `msgs` is newest first.
// Tool calls of tool-only assistant messages are folded into the next assistant text of the same turn.
export function historyLines(msgs, n, count) {
  const items = []
  let tools = new Map()
  for (const m of [...(msgs ?? [])].reverse()) {
    const parts = m.content ?? []
    const text = parts.filter((c) => c.type === "text").map((c) => c.text).join("\n").trim()
    if (m.type === "user") {
      tools = new Map()
      const t = (typeof m.text === "string" ? m.text.trim() : "") || text
      if (t) items.push(`[${n}] 你：${clip(t)}`)
    } else if (m.type === "assistant") {
      for (const c of parts) if (c.type === "tool") tools.set(c.name, (tools.get(c.name) ?? 0) + 1)
      if (!text) continue
      const used = [...tools].map(([k, v]) => (v > 1 ? `${k} ×${v}` : k)).join("、")
      items.push(`[${n}] AI：${clip(text)}${used ? `\n（调用了 ${used}）` : ""}`)
      tools = new Map()
    }
  }
  const out = items.slice(-count)
  if (!out.length) return [`[${n}] 还没有消息`]
  return [...out, `[${n}] 以上是最近 ${out.length} 条${out.length < count ? "（只找到这么多）" : ""}`]
}

// Returns the push text, or null when this event should not notify.
export function format(event, session, n, reply) {
  const d = event.data ?? {}
  const h = head(n, session, event.location?.directory) + "\n"
  switch (event.type) {
    case "session.execution.succeeded":
      return session?.parentID ? null : h + (clip(reply) || "完成（没有文字回复）")
    case "session.execution.failed":
      return h + "出错：" + short(d.error?.message || d.error?.type || "未知错误", 300)
    case "permission.asked": {
      const what = d.message || [d.action, ...(d.resources ?? [])].filter(Boolean).join(" ")
      return h + `等你批准：${short(what, 300)}\n回复「${n} y」批准一次，「${n} n」拒绝`
    }
    case "form.created": {
      const f = d.form ?? {}
      const lines = [`有问题问你：${short(f.title, 200) || "表单"}`]
      for (const x of (f.fields ?? []).filter((x) => !x.hidden)) {
        lines.push(short([x.title, x.description].filter(Boolean).join("：") || x.key, 300))
        ;(x.options ?? []).forEach((o, i) => lines.push(`  ${i + 1}. ${short(o.label, 80)}`))
      }
      lines.push(`回复「${n} 答案」${f.fields?.some((x) => x.options?.length) ? "（可以回编号）" : ""}`)
      return h + lines.join("\n")
    }
  }
  return null
}

const KEYWORDS = [
  ["list", /^(列表|\/?list|\/ls)$/i],
  ["help", /^(帮助|\/?help|\?|？)$/i],
  ["dirs", /^(目录|文件夹|\/?dirs?)$/i],
]
const keyword = (w) => KEYWORDS.find(([, re]) => re.test(w) || re.test(w.replace(/[。.！!？?~～…]+$/, "")))?.[0]

export function parseCommand(text) {
  const t = String(text ?? "").trim()
  // "列表。", "10 帮助", "帮助 列表": only no-arg keywords (an optional session number is ignored) run as commands.
  const words = t.replace(/^\d{1,4}[\s:：,，]+/, "").split(/[\s,，、]+/).filter(Boolean)
  const kws = words.map(keyword)
  if (words.length && kws.every(Boolean)) return kws.length === 1 ? { type: kws[0] } : { type: "multi", cmds: kws.map((type) => ({ type })) }
  // "目录2" or "目录 名字"; "目录结构怎么整理" stays a normal message.
  let m = t.match(/^(?:目录|文件夹|\/cd)(?:\s*(\d+)|\s+(.+))$/i)
  if (m) return { type: "cd", arg: (m[1] ?? m[2]).trim() }
  m = t.match(/^(?:新对话|\/new)(?:[\s:：,，]+([\s\S]+))?$/i)
  if (m) return { type: "new", text: m[1]?.trim() ?? "" }
  // Before the "3 内容" rule, so "3 历史" is never sent to the session as a prompt.
  m = t.match(/^(?:(\d{1,4})\s*)?(?:历史|\/history)(?:\s*(\d{1,4}))?$/i)
  if (m) return { type: "history", ...(m[1] && { n: Number(m[1]) }), count: Math.min(20, Math.max(1, Number(m[2] ?? 5))) }
  // Needs an image extension, so "图 好看吗" stays a normal message.
  m = t.match(/^(?:图|\/img)[\s:：]+(.+)$/i)
  const img = m?.[1].trim().replace(/^[`"'“「]+|[`"'”」]+$/g, "")
  if (img && IMG.test(img)) return { type: "image", path: img }
  m = t.match(/^(\d{1,4})$/)
  if (m) return { type: "show", n: Number(m[1]) }
  m = t.match(/^(\d{1,4})[\s:：,，]+([\s\S]+)$/)
  if (m) return { type: "text", n: Number(m[1]), text: m[2].trim() }
  return { type: "text", text: t }
}

// Answer for a form with exactly one visible field, or null when it can't be answered from one text message.
export function formAnswer(form, text) {
  const fields = (form?.fields ?? []).filter((f) => !f.hidden && f.type !== "external")
  if (fields.length !== 1) return null
  const f = fields[0]
  const t = String(text ?? "").trim()
  const pick = (s) => (f.options?.[Number(s) - 1] ?? f.options?.find((o) => o.label === s || o.value === s))?.value
  switch (f.type) {
    case "boolean":
      return YES.test(t) ? { [f.key]: true } : NO.test(t) ? { [f.key]: false } : null
    case "number":
    case "integer": {
      const v = Number(t)
      return t && Number.isFinite(v) ? { [f.key]: v } : null
    }
    case "multiselect":
      return { [f.key]: t.split(/[\s,，、]+/).filter(Boolean).map((s) => pick(s) ?? s) }
    default:
      return { [f.key]: pick(t) ?? t }
  }
}

// Text of an inbound iLink message from the owner, or null for anything else (other senders, bot echoes, media).
export function inboundText(msg, ownerID) {
  if (!ownerID || msg?.message_type !== 1 || msg.from_user_id !== ownerID || msg.group_id) return null
  const t = (msg.item_list ?? [])
    .map((i) => (i.type === 1 ? i.text_item?.text : i.type === 3 ? i.voice_item?.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim()
  return t || null
}

// Every plugin instance (one per location) receives every event; they share the event id.
export const eventKey = (event) =>
  event.id ?? `${sessionIDOf(event)}:${event.type}:${event.data?.id ?? event.data?.form?.id ?? ""}`

// ponytail: in-memory dedupe on globalThis, per process. Another server process only emits its own sessions' events.
const seen = (globalThis.__wechatNotifySeen ??= new Map())
export function shouldSend(key, now = Date.now()) {
  const last = seen.get(key)
  if (last !== undefined && now - last < DEBOUNCE_MS) return false
  seen.set(key, now)
  if (seen.size > 500) for (const [k, t] of seen) if (now - t > DEBOUNCE_MS) seen.delete(k)
  return true
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"))
  } catch {
    return null
  }
}

// Shared across all plugin instances and hot reloads in this process: live contexts and the single poller.
const g = (globalThis.__wechatBridge ??= { ctxs: new Set(), poller: null, handled: new Set() })
const GEN = {}
// State lives on disk and is re-read every time: several OpenCode server processes load this plugin and share it.
// ponytail: read-modify-write without a lock, fine for a few writes a minute; two processes numbering a new
// session in the same instant can still lose one mapping. A file lock fixes that if it ever shows up.
export const state = () => ({ next: 1, nums: {}, ...readJson(STATE_FILE) })
export function update(fn) {
  const s = state()
  fn(s)
  try {
    // Write then rename, so another process never reads a half-written file and saves defaults over it.
    const tmp = `${STATE_FILE}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(s))
    fs.renameSync(tmp, STATE_FILE)
  } catch (e) {
    warn("state save failed:", e)
  }
  return s
}
// Keys are OpenCode session ids, or `codex:<threadId>` for Codex threads; both share one numbering.
export function numOf(sessionID) {
  return state().nums[sessionID] ?? update((s) => (s.nums[sessionID] ??= s.next++)).nums[sessionID]
}
const sessionOf = (n) => Object.entries(state().nums).find(([, v]) => v === n)?.[0]

async function ilink(endpoint, body, signal = AbortSignal.timeout(15000)) {
  const account = readJson(path.join(DIR, "account.json"))
  if (!account?.token || !account?.baseUrl) throw new Error(`credentials missing in ${DIR}`)
  const res = await fetch(new URL(endpoint, account.baseUrl.replace(/\/?$/, "/")), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0))).toString("base64"),
      Authorization: `Bearer ${account.token.trim()}`,
    },
    body: JSON.stringify({ ...body, base_info: { channel_version: "0.3.0" } }),
    signal,
  })
  let json = {}
  try {
    json = JSON.parse((await res.text()) || "{}")
  } catch {}
  return { ...json, http: res.status, ok: res.ok }
}

// Throws a status line (no secrets) unless the iLink call succeeded.
function check(name, json) {
  const ret = Number(json.ret ?? 0)
  const errcode = Number(json.errcode ?? 0)
  const status = `http=${json.http} ret=${ret} errcode=${errcode}`
  if (json.ok && !ret && !errcode) return status
  const hint = ret === -2 ? " (context_token 过期，先给机器人发一条消息)" : ""
  throw new Error(`${name} failed: ${status} ${short(json.errmsg ?? "", 120)}${hint}`)
}

function recipient() {
  const account = readJson(path.join(DIR, "account.json"))
  const tokens = readJson(path.join(DIR, "context_tokens.json")) ?? {}
  const to = account?.userId
  const contextToken = state().contextToken ?? tokens[to] ?? Object.values(tokens).pop()
  if (!to || !contextToken) throw new Error(`credentials missing in ${DIR}`)
  return { to, contextToken }
}

async function sendItems(items) {
  const { to, contextToken } = recipient()
  const json = await ilink("ilink/bot/sendmessage", {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: `opencode-wechat-notify:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
      message_type: 2, // bot
      message_state: 2, // finished
      item_list: items,
      context_token: contextToken,
    },
  })
  return check("sendmessage", json)
}

// Sends one text message. Never throws; returns a short status string without secrets.
export async function send(text) {
  try {
    return await sendItems([{ type: 1, text_item: { text } }])
  } catch (e) {
    warn("send:", e)
    return "error"
  }
}

// null when `file` is a sendable image, else the reason.
async function imageProblem(file) {
  if (!IMG.test(file)) return "不是 png/jpg/gif/webp 图片"
  const st = await fs.promises.stat(file).catch(() => null)
  if (!st?.isFile()) return "文件不存在"
  return st.size > IMAGE_MAX_BYTES ? TOO_BIG : null
}

// Upload: getuploadurl → POST the AES-128-ECB ciphertext to the CDN → send an image item with the CDN's download param.
// Throws on failure; returns the status of each step (no secrets).
export async function sendImage(file) {
  const problem = await imageProblem(file)
  if (problem) throw new Error(`${path.basename(file)} ${problem}`)
  const { to } = recipient()
  const buf = await fs.promises.readFile(file)
  const key = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null)
  const data = Buffer.concat([cipher.update(buf), cipher.final()])
  const filekey = crypto.randomBytes(16).toString("hex")
  const r = await ilink("ilink/bot/getuploadurl", {
    filekey,
    media_type: 1, // image
    to_user_id: to,
    rawsize: buf.length,
    rawfilemd5: crypto.createHash("md5").update(buf).digest("hex"),
    filesize: data.length,
    aeskey: key.toString("hex"),
    no_need_thumb: true,
  })
  const steps = [`getuploadurl ${check("getuploadurl", r)}`]
  if (!r.upload_param) throw new Error("getuploadurl returned no upload_param")
  const q = `encrypted_query_param=${encodeURIComponent(r.upload_param)}&filekey=${filekey}`
  // ponytail: no retry on CDN 5xx; add one if uploads flake.
  const res = await fetch(`${CDN}/upload?${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: data,
    signal: AbortSignal.timeout(60_000),
  })
  const param = res.headers.get("x-encrypted-param")
  if (res.status !== 200 || !param)
    throw new Error(`cdn upload failed: http=${res.status} ${short(res.headers.get("x-error-message") ?? "", 120)}`)
  steps.push(`cdn http=${res.status}`)
  const media = { encrypt_query_param: param, aes_key: Buffer.from(key.toString("hex")).toString("base64"), encrypt_type: 1 }
  steps.push(`sendmessage ${await sendItems([{ type: 2, image_item: { media, mid_size: data.length } }])}`)
  return steps.join(", ")
}

// Absolute path for a path or file:/// URL as written; null for other URLs, or a relative path without a base.
function toPath(p, baseDir) {
  if (/^file:/i.test(p)) {
    try {
      return fileURLToPath(p)
    } catch {
      return null
    }
  }
  if (/^[a-z][\w+.-]+:/i.test(p)) return null
  return path.isAbsolute(p) ? path.resolve(p) : baseDir ? path.resolve(baseDir, p) : null
}

// Image paths mentioned in a reply: `code spans`, markdown link targets, and bare words. Paths with spaces need
// backticks or a markdown link.
export function imagePaths(text, baseDir) {
  const out = new Set()
  const re = /`([^`\n]+)`|\]\(\s*<?([^)>\n]+?)>?\s*\)|([^\s`"'<>|*?()[\]，。；：！？、「」（）]+)/g
  for (const m of String(text ?? "").matchAll(re)) {
    let raw = (m[1] ?? m[2] ?? m[3]).trim().replace(/[.,;:!]+$/, "")
    // "截图在C:\x.png": text glued before a drive letter or file: URL.
    raw = raw.slice(Math.max(0, raw.search(/(?<![a-z])([a-z]:[\\/]|file:)/i)))
    const p = IMG.test(raw) && toPath(raw, baseDir)
    if (p) out.add(p)
    if (out.size >= MAX_IMAGES) break
  }
  return [...out]
}

// Local OpenCode HTTP API, for what the plugin context doesn't expose in 2.0.32 (session list/active, forms, messages).
async function oc(pathname, body) {
  const svc = readJson(SERVICE_FILE)
  if (!svc?.url || !svc?.password) throw new Error("找不到 OpenCode 服务信息")
  const res = await fetch(new URL(pathname, svc.url.replace("0.0.0.0", "127.0.0.1")), {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: "Basic " + Buffer.from(`opencode:${svc.password}`).toString("base64"),
      ...(body && { "Content-Type": "application/json" }),
    },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`OpenCode 接口返回 ${res.status} ${short(await res.text(), 120)}`)
  return res.status === 204 ? undefined : res.json()
}

const sid = (id) => encodeURIComponent(id)
// Inbound commands go through the HTTP API, not a plugin ctx: ctx.permission.* only sees its own location's sessions.
const prompt = (sessionID, text) => oc(`/api/session/${sid(sessionID)}/prompt`, { text })
const lastReply = async (sessionID, stopAtUser = true) =>
  replyText((await oc(`/api/session/${sid(sessionID)}/message?limit=30&order=desc`)).data, stopAtUser)

async function push(sessionID, text) {
  update((s) => (s.last = sessionID))
  await send(text)
}

const sessionsURL = (limit, dir) =>
  `/api/session?limit=${limit}&parentID=null${dir ? `&directory=${encodeURIComponent(dir)}` : ""}`

async function listSessions(dir) {
  const [list, active] = await Promise.all([
    oc(sessionsURL(10, dir)),
    oc("/api/session/active").catch(() => ({ data: {} })),
  ])
  const lines = toArr(list)
    .filter((s) => !s.time?.archived)
    .map((s) => `${head(numOf(s.id), s)} · ${active.data?.[s.id] ? "运行中" : (STATUS[s.outcome] ?? "空闲")}`)
  return lines.length ? lines.join("\n") : "没有对话"
}

async function listDirs() {
  const dirs = toArr(await oc("/api/project"))
    .filter((p) => p.canonical && fs.existsSync(p.canonical))
    .sort((a, b) => (b.time?.active ?? 0) - (a.time?.active ?? 0))
    .map((p) => p.canonical)
  update((s) => (s.dirs = dirs))
  return dirs
}

// Folder by number from the last 「目录」 listing, or by folder name.
export function pickDir(dirs, arg) {
  if (/^\d+$/.test(arg)) return dirs[Number(arg) - 1]
  const a = arg.toLowerCase()
  return dirs.find((d) => base(d).toLowerCase() === a) ?? dirs.find((d) => base(d).toLowerCase().includes(a))
}

async function newSession(text) {
  const dir = state().dir
  if (!dir) return "先发「目录」选一个文件夹"
  // Reuse the folder's latest model: the server default may not be usable (it failed once with gpt-5.5).
  const model = toArr(await oc(sessionsURL(1, dir)).catch(() => []))[0]?.model
  const session = (await oc("/api/session", { location: { directory: dir }, ...(model && { model }) })).data
  const n = numOf(session.id)
  update((s) => (s.last = s.target = session.id))
  if (text) await prompt(session.id, text)
  return `已在 ${base(dir)} 新建 [${n}]${text ? "，已发出" : "，接着直接发内容就行"}`
}

async function run(cmd) {
  if (cmd.type === "multi") {
    const out = []
    for (const c of cmd.cmds) out.push(await run(c))
    return out.flat()
  }
  if (cmd.type === "help") return HELP
  if (cmd.type === "list") return listSessions()
  if (cmd.type === "dirs") {
    const dirs = await listDirs()
    return dirs.length ? `文件夹：\n${dirs.map((d, i) => `${i + 1}. ${base(d)}`).join("\n")}\n回复「目录 编号」选择` : "没有文件夹"
  }
  if (cmd.type === "cd") {
    const dir = pickDir(state().dirs ?? (await listDirs()), cmd.arg) ?? pickDir(await listDirs(), cmd.arg)
    if (!dir) return `没找到「${cmd.arg}」，发「目录」查看`
    update((s) => (s.dir = dir))
    return `已选中 ${base(dir)}\n${await listSessions(dir)}\n回复「编号 内容」继续旧对话，「新对话 内容」开新对话`
  }
  if (cmd.type === "new") return newSession(cmd.text)
  if (cmd.type === "image") {
    const file = toPath(cmd.path, state().dir)
    if (!file) return /^[a-z][\w+.-]+:/i.test(cmd.path) && !/^file:/i.test(cmd.path) ? "只能发电脑上的文件" : "相对路径要先发「目录」选文件夹"
    await sendImage(file)
    return [] // the image itself is the confirmation
  }
  if (cmd.type === "text" && !cmd.text) return HELP
  // Unnumbered text goes to the session the user last picked, not the last push: other sessions push all the time.
  const sessionID = cmd.n == null ? (state().target ?? state().last) : sessionOf(cmd.n)
  if (!sessionID) return cmd.n == null ? HELP : `没有 [${cmd.n}]，发「列表」查看`
  if (cmd.n != null && state().target !== sessionID) update((s) => (s.target = sessionID))
  const n = numOf(sessionID)
  if (sessionID.startsWith("codex:")) {
    const decision = cmd.type === "text" && cmd.n != null ? (YES.test(cmd.text) ? "allow" : NO.test(cmd.text) ? "deny" : null) : null
    if (!decision) return CODEX_TODO
    const ids = answerCodex(readPending(), n, decision)
    return ids.length ? `${decision === "allow" ? "已批准" : "已拒绝"} [${n}]` : `[${n}] 没有待批准的请求`
  }
  if (cmd.type === "show") {
    const session = (await oc(`/api/session/${sid(sessionID)}`)).data
    return `${head(n, session)}\n${clip(await lastReply(sessionID, false)) || "（还没有回复）"}`
  }
  if (cmd.type === "history") {
    // Tool-only assistant messages are skipped, so fetch extra.
    const limit = Math.min(100, cmd.count * 4 + 10)
    return historyLines((await oc(`/api/session/${sid(sessionID)}/message?limit=${limit}&order=desc`)).data, n, cmd.count)
  }
  const t = cmd.text
  // Approvals need an explicit number, so a casual "好" never approves a request you didn't see.
  const decision = cmd.n == null ? null : YES.test(t) ? "once" : NO.test(t) ? "reject" : null
  const perms = toArr(await oc(`/api/session/${sid(sessionID)}/permission`))
  if (decision && perms.length) {
    await oc(`/api/session/${sid(sessionID)}/permission/${sid(perms[0].id)}/reply`, { decision })
    // A reject also rejects every other pending request of the session.
    if (decision === "reject") return `已拒绝 [${n}]`
    return `已批准 [${n}]${perms.length > 1 ? `，还有 ${perms.length - 1} 个待批准` : ""}`
  }
  const forms = toArr(await oc(`/api/session/${sid(sessionID)}/form`))
  const answer = forms.length ? formAnswer(forms[0], t) : null
  if (answer) {
    await oc(`/api/session/${sid(sessionID)}/form/${sid(forms[0].id)}/reply`, { answer })
    return `已回答 [${n}]`
  }
  if (decision) return `[${n}] 没有待批准的请求`
  await prompt(sessionID, t)
  return `已发给 [${n}]${forms.length ? "（它在等一个表单，请在桌面端回答）" : ""}`
}

// Unanswered Codex approval requests, oldest first.
export function readPending(dir = PENDING_DIR) {
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {}
  return names
    .filter((f) => f.endsWith(".json") && !names.includes(f.replace(/\.json$/, ".answer")))
    .map((f) => readJson(path.join(dir, f)))
    .filter((p) => p?.id)
    .sort((a, b) => a.created - b.created)
}

// Picks which pending requests a 「N y」/「N n」 answers: allow approves the oldest one for N, deny rejects all of N's
// (same as OpenCode). Writes <id>.answer for each and returns their ids.
export function answerCodex(pending, n, decision, dir = PENDING_DIR) {
  const mine = pending.filter((p) => p.n === n)
  const picked = decision === "allow" ? mine.slice(0, 1) : mine
  for (const p of picked) fs.writeFileSync(path.join(dir, `${p.id}.answer`), decision)
  return picked.map((p) => p.id)
}

// Images mentioned in a reply that can be sent, plus names of the ones over the size limit.
export async function replyImages(reply, dir) {
  const files = []
  const big = []
  for (const f of imagePaths(reply, dir)) {
    const p = await imageProblem(f)
    if (!p) files.push(f)
    else if (p === TOO_BIG) big.push(path.basename(f))
  }
  return { files, big }
}

async function inbound(msg, floor) {
  const account = readJson(path.join(DIR, "account.json"))
  const text = inboundText(msg, account?.userId)
  if (text == null) return
  if (msg.context_token && msg.context_token !== state().contextToken) {
    update((s) => (s.contextToken = msg.context_token))
  }
  // Drop backlog: without a saved cursor the first poll can return old messages, and stale commands are risky.
  const created = Number(msg.create_time_ms ?? 0)
  if (created && created < floor()) return
  const key = msg.message_id ?? `${msg.client_id}:${created}`
  if (g.handled.has(key)) return
  g.handled.add(key)
  if (g.handled.size > 200) g.handled.delete(g.handled.values().next().value)
  const reply = await run(parseCommand(text)).catch((e) => `出错了：${short(e?.message, 150)}`)
  // run() returns a string, or an array sent one message at a time (spaced out so WeChat doesn't throttle).
  for (const [i, r] of [reply].flat().entries()) {
    if (i) await new Promise((resolve) => setTimeout(resolve, 300))
    await send(r)
  }
}

// Removes its abort listener when the timer fires; otherwise every sleep leaves one on the long-lived poller signal.
export const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const done = () => (clearTimeout(t), signal.removeEventListener("abort", done), resolve())
    const t = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })

async function poll(signal) {
  const startedAt = Date.now()
  const floor = state().buf ? () => Date.now() - 10 * 60_000 : () => startedAt
  let fails = 0
  while (!signal.aborted) {
    const t0 = Date.now()
    try {
      const r = await ilink(
        "ilink/bot/getupdates",
        { get_updates_buf: state().buf ?? "" },
        AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
      )
      if (Number(r.errcode) === -14) {
        update((s) => (s.buf = ""))
      }
      if (!r.ok || Number(r.ret ?? 0) !== 0 || Number(r.errcode ?? 0) !== 0)
        throw new Error(`getupdates http=${r.http} ret=${r.ret} errcode=${r.errcode} ${short(r.errmsg ?? "", 100)}`)
      if (r.get_updates_buf && r.get_updates_buf !== state().buf) {
        update((s) => (s.buf = r.get_updates_buf))
      }
      for (const m of r.msgs ?? []) await inbound(m, floor).catch((e) => warn("inbound:", e))
      fails = 0
      // A long poll that returns at once (proxy, outage, a cursor that never advances) would otherwise spin.
      if (Date.now() - t0 < 1000) await sleep(1000, signal)
    } catch (e) {
      if (signal.aborted) break
      if (e?.name === "TimeoutError" || e?.name === "AbortError") continue
      warn("poll:", e)
      await sleep(Math.min(300_000, 2000 * 2 ** fails++), signal)
    }
  }
}

const POLLS = process.env.WECHAT_NOTIFY_POLL === "1" || process.argv.includes("--service")

function startPoller() {
  update((s) => (s.pollerPid = process.pid))
  g.poller?.abort()
  const c = new AbortController()
  c.gen = GEN
  g.poller = c
  poll(c.signal).catch((e) => warn("poller stopped:", e))
}

export default {
  id: "wechat-notify",
  setup(ctx) {
    const controller = new AbortController()
    g.ctxs.add(ctx)
    // Other `opencode serve` processes (TUI etc.) load this plugin too; only the desktop service polls WeChat.
    // One poller per process; a hot-reloaded module replaces the old one.
    if (!POLLS) {
      g.poller?.abort()
      g.poller = null
    } else if (g.poller?.gen !== GEN) startPoller()
    const handle = async (event) => {
      if (!TYPES.has(event?.type)) return
      const sessionID = sessionIDOf(event)
      if (!sessionID || !shouldSend(eventKey(event))) return
      const session = await ctx.session.get({ sessionID }).catch(() => undefined)
      if (event.type === "session.execution.succeeded" && session?.parentID) return
      const reply =
        event.type === "session.execution.succeeded" ? await lastReply(sessionID).catch((e) => (warn(e), "")) : ""
      let text = format(event, session, numOf(sessionID), reply)
      if (!text) return
      const { files, big } = await replyImages(reply, session?.location?.directory ?? event.location?.directory)
      if (big.length) text += `\n（图片太大没发：${big.join("、")}）`
      await push(sessionID, text)
      for (const f of files) await sendImage(f).catch((e) => warn("image:", e))
    }
    void (async () => {
      try {
        // The types filter is ignored in 2.0.32 (every event arrives), so handle() filters too.
        for await (const event of ctx.event.subscribe({ types: [...TYPES], signal: controller.signal })) {
          handle(event).catch((e) => warn(e))
        }
      } catch (e) {
        if (!controller.signal.aborted) warn("event stream ended:", e)
      }
    })()
    return () => {
      controller.abort()
      g.ctxs.delete(ctx)
      if (!g.ctxs.size) {
        g.poller?.abort()
        g.poller = null
      }
    }
  },
}
