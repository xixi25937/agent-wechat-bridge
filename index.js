import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  BUSY, bridgeMarker, cleanDir, codexDirs, codexHead, codexMsgs, codexThread, codexThreads, createBridge, desktopApprove, desktopCompact, desktopInterrupt,
  desktopOwns, desktopSend,
} from "./codex.js"
import { desktopReply, readQuestion } from "./codex-question.js"
// Namespace import: a hot reload can pair this file with an older codex-question.js that lacks asyncAnswer.
import * as asyncQuestion from "./codex-question.js"
import { NO, YES, formAction, formText, questionForm } from "./form.js"

// session.idle exists in the client types but 2.0.32 never emits it; a finished run is session.execution.succeeded.
const TYPES = new Set([
  "session.execution.succeeded", "session.execution.failed", "permission.asked", "form.created",
  "session.text.ended", "session.tool.input.started", "session.execution.interrupted",
])
const ENDS = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])
// Progress pushes of one conversation are at least this far apart; a run shorter than this gets one push, as before.
const LIVE_MS = 15_000
// ponytail: iLink reportedly lets a bot send ~10 messages per message from the user (third-party reports, not
// documented). Progress stops at this many so the final reply and approvals still get through; the count is in the
// state file and resets on any message from the user.
const PROGRESS_MAX = 7
const DEBOUNCE_MS = 5000
// Longer text is cut here and ends with how much is left; up to that it goes out in chunks of CHUNK_CHARS.
const MAX_CHARS = 8000
// iLink reportedly cuts or rejects text past ~2000 characters (third-party reports, not documented).
const CHUNK_CHARS = 1800
const CHUNK_GAP_MS = 400
// A 「撤回」 waits this long for its 「撤回 确认」.
const UNSEND_MS = 2 * 60_000
const TAG = "[wechat-notify]"
export const DIR = process.env.WECHAT_NOTIFY_DIR || path.join(os.homedir(), ".cli-bridge")
const STATE_FILE = path.join(DIR, "opencode-wechat-notify.json")
// Codex approval handshake with codex-hook.js: <id>.json is the request, <id>.answer is "allow" or "deny".
export const PENDING_DIR = path.join(DIR, "codex-pending")
const CODEX = "codex:"
// A Codex approval record older than this no longer matches a 「N y」.
const PENDING_TTL = 60 * 60_000
const SERVICE_FILE = path.join(os.homedir(), ".local", "state", "opencode", "service.json")
const STATUS = { succeeded: "完成", failed: "出错", interrupted: "中断" }
const HELP = [
  "用法：",
  "3 内容 → 发给 [3] 号对话",
  "直接发内容 → 发给你上次用编号指定的对话（回复里会标明发给了哪个对话）",
  "[3] 有问题等你回答时：「3 答案」；几个问题可以一行一个一次回完，也可以一条一个；「-」跳过可选的，「3 忽略」不回答",
  "3 y / 3 n → 批准一次 / 拒绝 [3] 的权限请求",
  "3 → 再看一次 [3] 的最后回复",
  "3 历史 10 → [3] 最近 10 条消息（默认 5，最多 20）",
  "列表 → 最近的对话和编号（对话 24 小时没用，编号就回收给别的对话）",
  "目录 → 列出文件夹；目录 2 → 选中第 2 个文件夹并列出它的对话",
  "新对话 内容 → 在选中的文件夹里开新对话（标着 Codex 的文件夹开 Codex 对话）",
  "图 路径 → 把电脑上的图片发过来（相对路径按选中的文件夹算）",
  "发图片/文件 → 先存着，下一条文字（或「3 内容」）带上它们一起发；不用说明就回「发」或「3 图」（10 分钟内有效）",
  "实时 关 / 实时 开 → 关掉 / 打开回复过程中的推送（约 15 秒一条）；「3 实时 关」只管 [3]，「实时」看状态",
  "3 撤回 → 撤回你发给 [3] 的最后一条消息和之后的回复（要再发「3 撤回 确认」）；不带编号就是当前对话，也认 /unsend",
  "编号后面是 agent 和目录，如 [3] OpenCode · ttool、[5] Codex · proj；两种对话用法相同",
  "/ 命令见下一条",
].join("\n")
const SLASH_HELP = [
  "/ 命令（发给当前对话，也可以「3 /命令」指定）：",
  "/model → 列出模型；/model 3 或 /model 名字 → 切换模型",
  "/stop → 停止正在运行的回复",
  "/compact → 压缩上下文",
].join("\n")

export function slashHelpText(t, commands) {
  const lines = [SLASH_HELP]
  if (t) lines[0] = lines[0].replace("当前对话", `当前对话 ${t}`)
  if (commands?.length) {
    lines.push("", "OpenCode 自带命令：")
    for (const c of commands) lines.push(`/${c.name}${c.description ? ` → ${short(c.description, 50)}` : ""}`)
  }
  return lines.join("\n")
}

// The slash list for the current target: OpenCode commands depend on the session's folder (plugins, skills).
async function slashHelp() {
  const sessionID = targetID()
  if (!sessionID) return SLASH_HELP
  const t = await tag(sessionID)
  if (sessionID.startsWith(CODEX)) return slashHelpText(t) + "\n（Codex 对话只支持上面这三个）"
  const session = (await oc(`/api/session/${sid(sessionID)}`)).data
  const loc = `location[directory]=${encodeURIComponent(session?.location?.directory ?? "")}`
  return slashHelpText(t, toArr(await oc(`/api/command?${loc}`)))
}
const IMG = /\.(png|jpe?g|gif|webp)$/i
const MAX_IMAGES = 4
const IMAGE_MAX_BYTES = 10 * 1024 * 1024
const TOO_BIG = "太大（超过 10 MB）"
const CDN = "https://novac2c.cdn.weixin.qq.com/c2c"
const INBOUND_MAX_BYTES = 20 * 1024 * 1024
// Images and files from WeChat wait this long for the text they belong to.
export const PAIR_MS = 10 * 60_000
const SEND_WORD = /^(图|发|send)$/i

export const short = (s, n = 80) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim()
  return t.length > n ? t.slice(0, n - 1) + "…" : t
}
export const base = (dir) => (dir ? dir.split(/[\\/]/).filter(Boolean).pop() : "") || "?"
const toArr = (r) => (Array.isArray(r) ? r : (r?.data ?? []))
// console.warn from a plugin never reaches opencode.log, so failures also go to a file the user can read.
const warn = (...a) => {
  const line = a.map((x) => short(x?.message ?? x, 200)).join(" ")
  console.warn(TAG, line)
  try {
    fs.appendFileSync(path.join(DIR, "wechat-notify.log"), `${new Date().toLocaleString()} ${line}\n`)
  } catch {}
}

// Text up to `max` characters; longer text ends with how much is left. `n`: the conversation, for the 「N 历史 1」 hint.
export function clip(text, n, max = MAX_CHARS) {
  const t = String(text ?? "").trim()
  if (t.length <= max) return t
  return `${t.slice(0, max)}\n…（还有 ${t.length - max} 字，${n == null ? "" : `发「${n} 历史 1」或`}看桌面端）`
}

// One WeChat message per chunk of about `size` characters, cut at a paragraph or line break when one is in the
// second half of the chunk. Chunks are numbered "(1/3)": on the first line of the first (which carries the full
// "[N] OpenCode · 目录" tag), and after the short "[N]" on the others.
export function splitText(text, size = CHUNK_CHARS) {
  let rest = String(text ?? "")
  if (rest.length <= size) return [rest]
  const parts = []
  while (rest.length > size) {
    const win = rest.slice(0, size)
    let cut = win.lastIndexOf("\n\n")
    if (cut < size / 2) cut = win.lastIndexOf("\n")
    if (cut < size / 2) cut = /[\ud800-\udbff]/.test(win.at(-1)) ? size - 1 : size
    parts.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).replace(/^\n+/, "")
  }
  if (rest.trim()) parts.push(rest)
  const k = parts.length
  if (k === 1) return parts
  const tag = parts[0].match(/^\[\d+\]/)?.[0]
  return parts.map((p, i) => (i ? `${tag ? tag + " " : ""}(${i + 1}/${k})\n${p}` : p.replace(/^.*/, (l) => `${l} (1/${k})`)))
}

const AGENT = (key) => (key.startsWith(CODEX) ? "Codex" : "OpenCode")

// "[5] OpenCode · ttool": the tag every message uses where it names a conversation. No folder, no " · 目录".
export const tagText = (n, agent, dir) => `[${n}] ${agent}${dir ? ` · ${base(dir)}` : ""}`

// The same from the state `s`, for a key that has a number; the folder is whatever tag() cached.
export const tagIn = (s, key, n = s.nums[key]) => tagText(n, AGENT(key), s.info?.[key]?.dir)

// Cached in the state file (`info`), so a message naming a conversation needs no API call. Dropped with the number.
const remember = (key, dir) => dir && state().info?.[key]?.dir !== dir && update((s) => ((s.info ??= {})[key] = { dir }))

const findDir = async (key) =>
  key.startsWith(CODEX) ? cleanDir((await codexThread(key.slice(CODEX.length)))?.cwd) : (await oc(`/api/session/${sid(key)}`)).data?.location?.directory

// Tag of a conversation by key. `dir`: its folder when the caller has it (cached); otherwise the cache, and only
// when that is empty `find(key)` looks it up. A failed lookup leaves just "[N] OpenCode" / "[N] Codex".
export async function tag(key, dir, find = findDir) {
  await assign(key)
  remember(key, dir)
  if (!state().info?.[key]?.dir) remember(key, await find(key).catch(() => ""))
  return tagIn(state(), key)
}

export const head = (n, session, fallbackDir) => `${ocTag(n, session, fallbackDir)} / ${short(session?.title, 40) || "未命名会话"}`
const ocTag = (n, session, fallbackDir) => tagText(n, "OpenCode", session?.location?.directory ?? fallbackDir)

export function sessionIDOf(event) {
  return event?.data?.sessionID ?? event?.data?.form?.sessionID
}

// Text of the newest assistant message that has any; `msgs` is newest first. Stops at the run's user prompt.
export function replyText(msgs, stopAtUser = true) {
  for (const m of msgs ?? []) {
    // A compaction (「/compact」) ends the run too, so its push doesn't repeat the reply before it.
    if (stopAtUser && (m.type === "user" || m.type === "compaction")) break
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

const textOf = (parts) => (parts ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim()
const userText = (m) => (typeof m.text === "string" ? m.text.trim() : "") || textOf(m.content)

// What 「N 撤回」 takes back: the newest user message still queued in the inbox (`kind` "inbox"), else the newest one
// sent and the AI replies after it ("revert"). `msgs` newest first, `inbox` in queue order; null when there is none.
export function unsendPlan(msgs, inbox) {
  const q = (inbox ?? []).filter((i) => i.type === "user").at(-1)
  if (q) return { kind: "inbox", id: q.id, text: q.payload?.text ?? "", replies: 0 }
  let replies = 0
  for (const m of msgs ?? []) {
    if (m.type === "assistant" && textOf(m.content)) replies++
    if (m.type === "user") return { kind: "revert", id: m.id, text: userText(m), replies }
  }
  return null
}

// The same for a Codex thread: the newest turn with a user message (turns newest first); `id` is the turn id.
export function codexUnsendPlan(turns) {
  let replies = 0
  for (const t of turns ?? []) {
    const items = t.items ?? []
    replies += items.filter((i) => i.type === "agentMessage" && i.text?.trim()).length
    const u = items.find((i) => i.type === "userMessage")
    if (u) return { kind: "codex", id: t.id, text: textOf(u.content), replies }
  }
  return null
}

export const unsendAsk = (n, p, running, t = `[${n}]`) =>
  `${t} 将撤回${p.kind === "inbox" ? "还在排队的" : ""}「${short(p.text, 30)}」${p.replies ? `及之后的 ${p.replies} 条回复` : ""}` +
  `${running ? "（会先停止正在运行的回复）" : ""}，确认发「${n} 撤回 确认」（2 分钟内有效）`

// "shell ×3、edit" for a Map of tool name → calls.
const used = (tools) => [...tools].map(([k, v]) => (v > 1 ? `${k} ×${v}` : k)).join("、")

// One WeChat message per user / assistant message, oldest first, plus a closing line. `msgs` is newest first.
// Tool calls of tool-only assistant messages are folded into the next assistant text of the same turn.
// Only the first message carries the full tag `full`; the rest start with the short "[N]".
export function historyLines(msgs, n, count, full = `[${n}]`) {
  const items = []
  let tools = new Map()
  for (const m of [...(msgs ?? [])].reverse()) {
    const parts = m.content ?? []
    const text = parts.filter((c) => c.type === "text").map((c) => c.text).join("\n").trim()
    if (m.type === "user") {
      tools = new Map()
      const t = userText(m)
      if (t) items.push(`你：${clip(t)}`)
    } else if (m.type === "assistant") {
      for (const c of parts) if (c.type === "tool") tools.set(c.name, (tools.get(c.name) ?? 0) + 1)
      if (!text) continue
      const u = used(tools)
      items.push(`AI：${clip(text)}${u ? `\n（调用了 ${u}）` : ""}`)
      tools = new Map()
    }
  }
  const out = items.slice(-count)
  if (!out.length) return [`${full} 还没有消息`]
  return [...out.map((x, i) => `${i ? `[${n}]` : full} ${x}`), `[${n}] 以上是最近 ${out.length} 条${out.length < count ? "（只找到这么多）" : ""}`]
}

// Returns the push text, or null when this event should not notify. `live`: see doneText.
export function format(event, session, n, reply, live) {
  const d = event.data ?? {}
  const hd = head(n, session, event.location?.directory)
  const h = hd + "\n"
  switch (event.type) {
    case "session.execution.succeeded":
      return session?.parentID ? null : doneText(hd, n, reply, live, ocTag(n, session, event.location?.directory))
    case "session.execution.failed":
      return h + "出错：" + short(d.error?.message || d.error?.type || "未知错误", 300)
    case "permission.asked": {
      const what = d.message || [d.action, ...(d.resources ?? [])].filter(Boolean).join(" ")
      return h + `等你批准：${short(what, 300)}\n回复「${n} y」批准一次，「${n} n」拒绝`
    }
    case "form.created":
      return h + formText(d.form, n)
  }
  return null
}

// Live progress (see takeLive): `live` is { body, pushed }, the text not pushed yet and whether any of the run was.
// A run that pushed progress ends with only what wasn't pushed, or one line when nothing is left; any other run
// ends with its last reply, as without progress. `t`: the conversation's tag, for the one-line ending.
export const doneText = (h, n, reply, live, t = `[${n}]`) =>
  !live?.pushed ? `${h}\n${clip(reply, n) || "完成（没有文字回复）"}` : live.body ? `${h}\n${clip(live.body, n)}` : `${t} 完成`

// Errors, approvals and questions carry the pending progress first (after the header line), so order is kept.
export const withPre = (msg, live) => (live?.body ? msg.replace("\n", `\n${clip(live.body)}\n\n`) : msg)

// Body of a progress push: the text segments finished since the last push, then the tools called since then.
// Empty without text: a tool summary alone waits for the next text.
export function liveBody(texts, tools) {
  const t = texts.map((s) => s.trim()).filter(Boolean).join("\n\n")
  const u = used(tools ?? [])
  return t && t + (u ? `\n（调用了 ${u}）` : "")
}

// Wait before the next progress push of a conversation whose last push (or first segment) was at `at`.
export const liveDelay = (at, now = Date.now()) => Math.max(0, at + LIVE_MS - now)

// Whether a conversation gets progress pushes: its own 「N 实时 开/关」, else the global one, else on.
export const liveOn = (s, key) => s.live?.[key] ?? s.live?.["*"] ?? true

// Reply to 「实时」: status with `on` undefined, else the switch. `key` is the session key, or "*" for all.
export function liveCmd(s, key, n, on) {
  const word = (v) => (v ? "开" : "关")
  if (on == null) {
    if (key !== "*") return `${tagIn(s, key, n)} 实时推送：${word(liveOn(s, key))}`
    const all = liveOn(s, "*")
    const other = Object.entries(s.live ?? {}).filter(([k, v]) => k !== "*" && v !== all && s.nums[k]).map(([k]) => tagIn(s, k))
    return `实时推送：${word(all)}${other.length ? `（${other.join("、")} ${word(!all)}）` : ""}\n「实时 关」/「实时 开」切换所有对话，「编号 实时 关」只切换一个`
  }
  if (key === "*") s.live = { "*": on }
  else (s.live ??= {})[key] = on
  return `${key === "*" ? "所有对话的" : `${tagIn(s, key, n)} 的`}实时推送已${on ? "打开" : "关闭"}${on ? "" : "，回复完成时照常推送"}`
}

const KEYWORDS = [
  ["list", /^(列表|\/?list|\/ls)$/i],
  ["help", /^(帮助|\/?help|\?|？|\/|／)$/i],
  ["dirs", /^(目录|文件夹|\/?dirs?)$/i],
]
const OWN_SLASH = new Set(["list", "ls", "help", "dir", "dirs", "cd", "new", "history", "img", "live", "unsend"])
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
  m = t.match(/^(?:(\d{1,4})\s*)?(?:实时|\/live)(?:\s*(开|关|on|off))?$/i)
  if (m) return { type: "live", ...(m[1] && { n: Number(m[1]) }), ...(m[2] && { on: /^(开|on)$/i.test(m[2]) }) }
  // 「3 撤回」「撤回 3」「/unsend 3」, then 「3 撤回 确认」. "撤回上一步的修改" stays a normal message.
  m = t.match(/^(?:(\d{1,4})\s*)?(?:撤回|\/unsend)(?:\s*(\d{1,4}))?(?:\s*(确认|confirm))?$/i)
  if (m && !(m[1] && m[2])) return { type: "unsend", ...((m[1] ?? m[2]) && { n: Number(m[1] ?? m[2]) }), ...(m[3] && { confirm: true }) }
  // Before the "3 内容" rule, so "3 历史" is never sent to the session as a prompt.
  m = t.match(/^(?:(\d{1,4})\s*)?(?:历史|\/history)(?:\s*(\d{1,4}))?$/i)
  if (m) return { type: "history", ...(m[1] && { n: Number(m[1]) }), count: Math.min(20, Math.max(1, Number(m[2] ?? 5))) }
  // Needs an image extension, so "图 好看吗" stays a normal message.
  m = t.match(/^(?:图|\/img)[\s:：]+(.+)$/i)
  const img = m?.[1].trim().replace(/^[`"'“「]+|[`"'”」]+$/g, "")
  if (img && IMG.test(img)) return { type: "image", path: img }
  // "/model 3", "5 /stop". The plugin's own slash commands are matched above; a malformed one shows help rather
  // than reaching the AI. "/usr/bin 是什么" has no space after the name and stays a normal message.
  m = t.match(/^(?:(\d{1,4})[\s:：,，]+)?\/([a-z][\w:.-]*)(?:\s+([\s\S]*))?$/i)
  if (m) {
    const own = m[2].toLowerCase()
    if (OWN_SLASH.has(own)) return { type: own === "cd" ? "dirs" : "help" }
    return { type: "slash", ...(m[1] && { n: Number(m[1]) }), name: m[2], args: m[3]?.trim() ?? "" }
  }
  m = t.match(/^(\d{1,4})$/)
  if (m) return { type: "show", n: Number(m[1]) }
  m = t.match(/^(\d{1,4})[\s:：,，]+([\s\S]+)$/)
  if (m) return { type: "text", n: Number(m[1]), text: m[2].trim() }
  return { type: "text", text: t }
}

const fromOwner = (msg, ownerID) => !!ownerID && msg?.message_type === 1 && msg.from_user_id === ownerID && !msg.group_id

// Text of an inbound iLink message from the owner, or null for anything else (other senders, bot echoes, media).
export function inboundText(msg, ownerID) {
  if (!fromOwner(msg, ownerID)) return null
  const t = (msg.item_list ?? [])
    .map((i) => (i.type === 1 ? i.text_item?.text : i.type === 3 ? i.voice_item?.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim()
  return t || null
}

// Image (item type 2) and file (type 4) items of an owner's message: CDN media, AES key, name and declared size.
export function inboundMedia(msg, ownerID) {
  if (!fromOwner(msg, ownerID)) return []
  return (msg.item_list ?? []).flatMap((i) => {
    const kind = i.type === 2 ? "image" : i.type === 4 ? "file" : null
    const it = kind === "image" ? i.image_item : i.file_item
    if (!kind) return []
    const key = it?.media?.aes_key ?? it?.media?.aeskey ?? it?.aes_key ?? it?.aeskey
    return [{ kind, media: it?.media, key, name: String(it?.file_name ?? "").trim(), size: Number(kind === "image" ? it?.mid_size : it?.len) || 0 }]
  })
}

// AES-128 key of inbound media: 32 hex chars, base64 of the 16 raw bytes, or base64 of the 32 hex chars (what we send).
export function aesKeyOf(value) {
  const t = String(value ?? "").trim()
  const hex = /^[0-9a-f]{32}$/i
  if (hex.test(t)) return Buffer.from(t, "hex")
  const raw = Buffer.from(t, "base64")
  if (raw.length === 16) return raw
  const s = raw.toString("utf8").trim()
  if (hex.test(s)) return Buffer.from(s, "hex")
  throw new Error("不认识的密钥格式")
}

// File extension from the first bytes, or null.
export function extOf(buf) {
  const s = (a, b) => buf.toString("latin1", a, b)
  if (buf[0] === 0x89 && s(1, 4) === "PNG") return "png"
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg"
  if (s(0, 4) === "GIF8") return "gif"
  if (s(0, 4) === "RIFF" && s(8, 12) === "WEBP") return "webp"
  if (s(4, 8) === "ftyp" && /^(heic|heix|mif1)$/.test(s(8, 12))) return "heic"
  if (s(0, 2) === "BM") return "bmp"
  if (s(0, 4) === "%PDF") return "pdf"
  if (s(0, 4) === "PK\x03\x04") return "zip"
  return null
}
const IMAGE_EXTS = new Set(["png", "jpg", "gif", "webp"])

const cdnURL = (media) => {
  try {
    const u = new URL(media?.full_url?.trim() ?? "")
    if (u.protocol === "https:" && u.hostname === new URL(CDN).hostname) return u.href
  } catch {}
  const param = media?.encrypt_query_param?.trim()
  if (!param) throw new Error("没有下载参数")
  return `${CDN}/download?encrypted_query_param=${encodeURIComponent(param)}`
}

// Downloads and decrypts one inbound media item (CDN GET, AES-128-ECB). Throws over INBOUND_MAX_BYTES.
export async function downloadMedia(media, key) {
  const aes = aesKeyOf(key)
  const res = await fetch(cdnURL(media), { signal: AbortSignal.timeout(60_000) })
  if (res.status !== 200) throw new Error(`cdn download http=${res.status} ${short(res.headers.get("x-error-message") ?? "", 120)}`)
  const chunks = []
  let n = 0
  for await (const c of res.body) {
    if ((n += c.length) > INBOUND_MAX_BYTES + 16) throw new Error("超过 20 MB")
    chunks.push(c)
  }
  const d = crypto.createDecipheriv("aes-128-ecb", aes, null)
  return Buffer.concat([d.update(Buffer.concat(chunks)), d.final()])
}

const day = (t = new Date()) => `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`

// Saves an inbound item under DIR/inbound-images/<date>/; images that aren't png/jpg/gif/webp count as files.
async function saveMedia(d) {
  if (d.size > INBOUND_MAX_BYTES) throw new Error("超过 20 MB")
  if (!d.media || !d.key) throw new Error("没有下载信息")
  const buf = await downloadMedia(d.media, d.key)
  const ext = extOf(buf)
  const kind = d.kind === "image" && IMAGE_EXTS.has(ext) ? "image" : "file"
  const id = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`
  // Files keep their name (the agent sees it); "a/../b" or reserved characters can't escape the folder.
  const name = kind === "file" && d.name ? `${id}-${d.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")}` : `${id}.${ext ?? "bin"}`
  const dir = path.join(DIR, "inbound-images", day())
  await fs.promises.mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
  await fs.promises.writeFile(file, buf)
  return { kind, path: file }
}

// Buffered media that is still waiting for its text.
export const liveMedia = (items, now = Date.now()) => (items ?? []).filter((i) => now - i.at < PAIR_MS)

// Prompt text and image paths for a message with buffered media. 「发」/「图」 alone sends them with a default text;
// files other than images go in as their saved paths.
export function withMedia(text, items) {
  const images = items.filter((i) => i.kind === "image").map((i) => i.path)
  const files = items.filter((i) => i.kind !== "image").map((i) => i.path)
  let t = items.length && SEND_WORD.test(text.trim()) ? (images.length ? "请看图片" : "请看文件") : text
  if (files.length) t += `\n\n微信发来的文件已保存在：\n${files.join("\n")}`
  return { text: t, images }
}

// Reply to an image or file without text. `target` is like "[3]"; `failed` counts items that couldn't be downloaded.
export function mediaAck(items, target, failed = 0) {
  const imgs = items.filter((i) => i.kind === "image").length
  const files = items.length - imgs
  const what = !files ? `图片（共 ${imgs} 张）` : !imgs ? `文件（共 ${files} 个）` : `图片和文件（共 ${imgs} 张图片、${files} 个文件）`
  const bad = failed ? `有 ${failed} 个没收到（下载失败）` : ""
  if (!items.length) return bad
  const to = target ? `会一起发给 ${target}` : "用「编号 文字」指定发给哪个对话"
  return `${bad ? bad + "；" : ""}收到${what}，接着发文字说明，${to}（不用说明就回「发」）`
}

// Models as { id, providerID?, label, name, image, isDefault }. By list number, exact id / label, or name fragment;
// returns every match so the caller can ask again when there are several.
export function pickModel(models, arg) {
  const a = String(arg ?? "").trim().toLowerCase()
  if (/^\d+$/.test(a)) return models[Number(a) - 1] ? [models[Number(a) - 1]] : []
  const exact = models.filter((m) => m.label.toLowerCase() === a || m.id.toLowerCase() === a)
  return exact.length ? exact : models.filter((m) => `${m.label} ${m.name ?? ""}`.toLowerCase().includes(a))
}

export const modelLines = (models, current) =>
  models.map((m, i) => `${i + 1}. ${m.label}${m.label === current ? " ← 当前" : ""}${m.image ? "" : "（不看图）"}`)

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
// Live progress per conversation (see addText). Each plugin instance evaluates this module, and a new folder adds an
// instance at any time, so the map is kept across evaluations; a pending timer of a reloaded module runs its old code once.
if (!(g.progress instanceof Map)) g.progress = new Map()
// State lives on disk and is re-read every time: several OpenCode server processes load this plugin and share it.
// ponytail: read-modify-write without a lock, fine for a few writes a minute; two processes numbering a new
// session in the same instant can still lose one mapping. A file lock fixes that if it ever shows up.
export const state = () => ({ nums: {}, ...readJson(STATE_FILE) })
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
// A number freed by removing its key from nums is handed out again; old state files may still carry an unused `next`.
export function lowestFree(nums) {
  const used = new Set(Object.values(nums))
  let n = 1
  while (used.has(n)) n++
  return n
}

// A number is kept while its conversation is in use: `used[key]` (ms) is when it was last pushed, addressed or listed,
// and prune() releases the numbers of conversations that are gone or unused for KEEP_MS.
export const KEEP_MS = 24 * 60 * 60_000
const PRUNE_MS = 10 * 60_000
// numOf refreshes `used` at most this often, so listing ten conversations isn't ten writes.
const TOUCH_MS = 60_000
const noNum = (n) => `没有 [${n}]（编号会在对话 ${KEEP_MS / 3_600_000} 小时没用后回收），发「列表」查看`

// Every call counts as a use of the conversation.
export function numOf(key) {
  const { nums, used } = state()
  if (nums[key] != null && Date.now() - (used?.[key] ?? 0) < TOUCH_MS) return nums[key]
  return update((s) => {
    s.nums[key] ??= lowestFree(s.nums)
    s.used = { ...s.used, [key]: Date.now() }
  }).nums[key]
}
const sessionOf = (n) => {
  const key = Object.entries(state().nums).find(([, v]) => v === n)?.[0]
  if (key) numOf(key)
  return key
}

// Keys whose numbers to release: the conversation is gone (`exists(key)` false) or unused for KEEP_MS. Never the
// target or last conversation, one with a saved form, or one `busy(key)` (running, or waiting for a permission,
// an answer or an approval). A key without a `used` entry counts as used now.
export function prunable(s, now, { exists = () => true, busy = () => false } = {}) {
  return Object.keys(s.nums ?? {}).filter((key) => {
    if (key === s.target || key === s.last || s.forms?.[key] || busy(key)) return false
    return !exists(key) || now - (s.used?.[key] ?? now) >= KEEP_MS
  })
}

// Ids of the Codex threads that aren't archived, or null when the state db can't be read (or lists none), so a failed
// read isn't taken as "all gone". Kept here, not in codex.js: a hot reload that keeps an older codex.js must still load.
async function codexAliveIds() {
  try {
    const { DatabaseSync } = await import("node:sqlite")
    const db = new DatabaseSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "state_5.sqlite"), { readOnly: true })
    try {
      const rows = db.prepare("select id from threads where archived = 0").all()
      return rows.length ? new Set(rows.map((r) => r.id)) : null
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

// Asks OpenCode, the Codex state db and the approval files about the numbered conversations that could be released:
// { gone, busy } as sets of keys. One whose state can't be read counts as busy, so it is kept.
async function probe(s, now) {
  const gone = new Set()
  const busy = new Set()
  const keys = Object.keys(s.nums).filter((k) => k !== s.target && k !== s.last && !s.forms?.[k])
  const stale = (k) => now - (s.used?.[k] ?? now) >= KEEP_MS
  let up = true
  const running = await oc("/api/session/active").then((r) => r.data ?? {}, () => ((up = false), {}))
  // Waiting for a permission or an answer only matters to a conversation about to be released for age. A 404 there is
  // a session whose folder is gone (LocationNotFoundError): nothing can be waiting in it. Any other error counts as waiting.
  const asks = (k, x) => oc(`/api/session/${sid(k)}/${x}`).then((r) => toArr(r).length > 0, (e) => e.status !== 404)
  const waiting = async (k) => (await Promise.all([asks(k, "permission"), asks(k, "form")])).some(Boolean)
  for (const k of keys.filter((k) => !k.startsWith(CODEX))) {
    if (up) {
      try {
        await oc(`/api/session/${sid(k)}`)
      } catch (e) {
        // Only the server's own "Session not found" counts: a 404 from a wrong route has no such body.
        if (e.status === 404 && e.message.includes("Session not found")) {
          gone.add(k)
          continue
        }
        up = false
      }
    }
    if (!up || running[k] || (stale(k) && (await waiting(k)))) busy.add(k)
  }
  const pending = readPending()
  const alive = await codexAliveIds()
  for (const k of keys.filter((k) => k.startsWith(CODEX))) {
    const id = k.slice(CODEX.length)
    if (alive && !alive.has(id)) gone.add(k)
    if (g.bridge?.running(id) || fs.existsSync(bridgeMarker(PENDING_DIR, id)) || pending.some((p) => p.threadId === id) || readQuestion(PENDING_DIR, id)) busy.add(k)
  }
  return { gone, busy }
}

// At most every PRUNE_MS (across processes: `prunedAt` is in the state file). The API calls come first; the state
// is then changed in one read-modify-write.
// ponytail: the plugin and the Codex hook processes can both prune or number in the same instant, and one write can
// then undo the other's (a released number comes back, or a new mapping is lost; the next prune or message fixes it).
export function prune() {
  return (g.pruning ??= pruneNow()
    .catch((e) => warn("prune:", e))
    .finally(() => (g.pruning = null)))
}

async function pruneNow() {
  const now = Date.now()
  if (now - (state().prunedAt ?? 0) < PRUNE_MS) return
  const { gone, busy } = await probe(state(), now)
  update((s) => {
    s.prunedAt = now
    // Keys from before `used` existed start their 24 hours now.
    for (const k of Object.keys(s.nums)) (s.used ??= {})[k] ??= now
    for (const k of prunable(s, now, { exists: (k) => !gone.has(k), busy: (k) => busy.has(k) })) {
      delete s.nums[k]
      delete s.used[k]
      delete s.live?.[k]
      delete s.info?.[k]
      if (k.startsWith(CODEX)) delete s.codexModels?.[k.slice(CODEX.length)]
    }
  })
}

// numOf for a conversation that may not have a number yet: prunes first, so a freed number is handed out again.
export async function assign(key) {
  if (!state().nums[key]) await prune()
  return numOf(key)
}

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
  const hint = ret === -2 ? " (context_token 过期或这条消息之后发得太多，给机器人发一条消息就恢复)" : ""
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

// iLink answers ret=-2 ("prepare failed") for a stale context_token, a burst of sends, and reportedly once a token
// has carried ~10 bot messages. One retry after a pause covers a burst, and picks up a token that arrived meanwhile.
const RETRY_MS = 2000

async function sendItems(items) {
  for (let i = 0; ; i++) {
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
    if (i || Number(json.ret) !== -2) {
      const status = check("sendmessage", json)
      // Bot messages since the user's last message; live progress pauses near the limit (see PROGRESS_MAX).
      update((s) => (s.sent = (s.sent ?? 0) + 1))
      return status
    }
    warn(`sendmessage ret=-2 ${short(json.errmsg ?? "", 60)}, retrying in ${RETRY_MS / 1000} s`)
    await new Promise((r) => setTimeout(r, RETRY_MS))
  }
}

// Sends a text, split into numbered chunks one after another (see splitText). Never throws; returns a short
// status string without secrets. A failed chunk stops the rest, so a later chunk never arrives without it.
export async function send(text) {
  const chunks = splitText(text)
  try {
    let status = ""
    for (const [i, c] of chunks.entries()) {
      if (i) await new Promise((r) => setTimeout(r, CHUNK_GAP_MS))
      status = await sendItems([{ type: 1, text_item: { text: c } }])
    }
    return chunks.length > 1 ? `${status} ×${chunks.length}` : status
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
  const { item, steps } = await uploadImage(file)
  steps.push(`sendmessage ${await sendItems([item])}`)
  return steps.join(", ")
}

// Upload only: the image item sendmessage would carry, and the step statuses.
export async function uploadImage(file) {
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
  return { item: { type: 2, image_item: { media, mid_size: data.length } }, steps }
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
async function oc(pathname, body, method = body ? "POST" : "GET") {
  const svc = readJson(SERVICE_FILE)
  if (!svc?.url || !svc?.password) throw new Error("找不到 OpenCode 服务信息")
  const res = await fetch(new URL(pathname, svc.url.replace("0.0.0.0", "127.0.0.1")), {
    method,
    headers: {
      Authorization: "Basic " + Buffer.from(`opencode:${svc.password}`).toString("base64"),
      ...(body && { "Content-Type": "application/json" }),
    },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) {
    const t = await res.text()
    let msg = t
    try {
      msg = JSON.parse(t).message ?? t
    } catch {}
    throw Object.assign(new Error(`OpenCode 接口返回 ${res.status} ${short(msg, 200)}`), { status: res.status })
  }
  return res.status === 204 ? undefined : res.json()
}

const sid = (id) => encodeURIComponent(id)
// Inbound commands go through the HTTP API, not a plugin ctx: ctx.permission.* only sees its own location's sessions.
// Images go as file:// URIs; the server reads them and stores them inline with their mime type.
const prompt = (sessionID, text, images = []) =>
  oc(`/api/session/${sid(sessionID)}/prompt`, {
    text,
    ...(images.length && { files: images.map((p) => ({ uri: pathToFileURL(p).href, name: path.basename(p) })) }),
  })
const lastReply = async (sessionID, stopAtUser = true) =>
  replyText((await oc(`/api/session/${sid(sessionID)}/message?limit=30&order=desc`)).data, stopAtUser)

// Pushes go out one at a time in call order, so a progress push in flight never lands after the push that follows it.
function push(sessionID, text) {
  update((s) => (s.last = sessionID))
  return (g.chain = (g.chain ?? Promise.resolve()).then(() => send(text)))
}

// --- live progress: finished text segments of a running conversation, pushed at most every LIVE_MS ---
// One entry per conversation key (OpenCode session id or codex:<thread>) while it runs, shared by all plugin instances:
// { texts, tools, at, pushed, timer, info, child }. `info()` resolves to { head } or { child: true } at push time.

const NO_LIVE = { body: "", pushed: false }
const PAUSE = "\n（实时推送先停一下：微信限制机器人连着发消息，回「实时」继续）"

function liveEntry(key, info) {
  let e = g.progress.get(key)
  if (!e) g.progress.set(key, (e = { texts: [], tools: new Map(), pushed: false, info }))
  return e
}

export function addText(key, text, info) {
  if (!String(text ?? "").trim()) return
  const e = liveEntry(key, info)
  if (e.child) return
  e.texts.push(text)
  // The first push waits LIVE_MS from the first segment, so a short run still ends with a single push.
  e.at ??= Date.now()
  e.timer ??= setTimeout(() => flushLive(key, e).catch((err) => warn("live:", err)), liveDelay(e.at))
}

export function addTool(key, name, info) {
  const e = liveEntry(key, info)
  if (name && !e.child) e.tools.set(name, (e.tools.get(name) ?? 0) + 1)
}

// Takes the conversation's unpushed progress: `body` (empty when none) and whether an earlier part of the run was
// pushed. Synchronous, so a caller that takes it before its first await sees every segment that came before.
// `end`: the run is over, drop the entry. With progress off (`on` false) the text is dropped, unless part of the
// run already went out: then the final push still carries the rest.
export function takeLive(key, end, on = true) {
  const e = g.progress.get(key)
  if (!e) return NO_LIVE
  clearTimeout(e.timer)
  e.timer = null
  if (end) g.progress.delete(key)
  const r = { body: on || e.pushed ? liveBody(e.texts, e.tools) : "", pushed: e.pushed }
  Object.assign(e, { texts: [], tools: new Map() })
  if (r.body) Object.assign(e, { pushed: true, at: Date.now() })
  return r
}

async function flushLive(key, e) {
  e.timer = null
  const s = state()
  // Off, or out of messages for now: the text waits for the next push of this run.
  if (g.progress.get(key) !== e || !liveOn(s, key) || (s.sent ?? 0) >= PROGRESS_MAX) return
  const { head: h, child } = await e.info()
  if (child) return void Object.assign(e, { child: true, texts: [], tools: new Map() })
  if (g.progress.get(key) !== e) return
  const { body } = takeLive(key)
  if (body) await push(key, `${h}\n${clip(body)}${(s.sent ?? 0) + 1 >= PROGRESS_MAX ? PAUSE : ""}`)
}

const sessionsURL = (limit, dir) =>
  `/api/session?limit=${limit}&parentID=null${dir ? `&directory=${encodeURIComponent(dir)}` : ""}`

// One line per conversation, newest first: `{ updated, line }` from OpenCode and Codex merged.
export const mergeLines = (rows, limit = 10) =>
  [...rows].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0)).slice(0, limit).map((r) => r.line)

const codexLine = (t) => ({
  updated: t.updated,
  line: `${codexHead(numOf(CODEX + t.id), t.cwd, t, { base, short })} · ${bridge().running(t.id) ? "运行中" : "空闲"}`,
})

// `dir` is an OpenCode folder, or `codex:<folder>` for one listing only Codex threads.
async function listSessions(dir) {
  await prune()
  if (dir?.startsWith(CODEX)) {
    const lines = (await codexThreads({ cwd: dir.slice(CODEX.length) })).map((t) => codexLine(t).line)
    return lines.length ? lines.join("\n") : "没有对话"
  }
  const [list, active, codex] = await Promise.all([
    oc(sessionsURL(10, dir)),
    oc("/api/session/active").catch(() => ({ data: {} })),
    dir ? [] : codexThreads(),
  ])
  const rows = toArr(list)
    .filter((s) => !s.time?.archived)
    .map((s) => ({
      updated: s.time?.updated,
      line: `${head(numOf(s.id), s)} · ${active.data?.[s.id] ? "运行中" : (STATUS[s.outcome] ?? "空闲")}`,
    }))
  const lines = mergeLines([...rows, ...codex.map(codexLine)])
  return lines.length ? lines.join("\n") : "没有对话"
}

// OpenCode folders, then `codex:<folder>` for the folders of Codex threads.
async function listDirs() {
  const [projects, codex] = await Promise.all([oc("/api/project").catch((e) => (warn(e), [])), codexDirs()])
  const dirs = [
    ...toArr(projects)
      .filter((p) => p.canonical && fs.existsSync(p.canonical))
      .sort((a, b) => (b.time?.active ?? 0) - (a.time?.active ?? 0))
      .map((p) => p.canonical),
    ...codex.map((d) => CODEX + d.cwd),
  ]
  update((s) => (s.dirs = dirs))
  return dirs
}

export const dirLabel = (d) => (d.startsWith(CODEX) ? `Codex · ${base(d.slice(CODEX.length))}` : base(d))
const dirPath = (d) => (d?.startsWith(CODEX) ? d.slice(CODEX.length) : d)

// Folder by number from the last 「目录」 listing, or by folder name.
export function pickDir(dirs, arg) {
  if (/^\d+$/.test(arg)) return dirs[Number(arg) - 1]
  // 「目录 Codex · 11」 or 「目录 codex 11」 picks among Codex folders only.
  const a = arg.trim().toLowerCase()
  const name = a.replace(/^codex(\s*[·.]\s*|\s+)/, "")
  const ds = name !== a ? dirs.filter((d) => d.startsWith(CODEX)) : dirs
  return ds.find((d) => base(dirPath(d)).toLowerCase() === name) ?? ds.find((d) => base(dirPath(d)).toLowerCase().includes(name))
}

async function newSession(text) {
  const dir = state().dir
  if (!dir) return "先发「目录」选一个文件夹"
  if (dir.startsWith(CODEX)) {
    if (!text) return "Codex 新对话要带内容：「新对话 内容」"
    const cwd = dirPath(dir)
    const m = takeMedia(text)
    const id = await bridge().create(cwd, m.text, { images: m.images })
    const t = await tag(CODEX + id, cwd)
    update((s) => (s.last = s.target = CODEX + id))
    return `已新建 ${t}，已发出${m.note}（在后台运行，桌面端重新打开这个对话能看到）`
  }
  // Reuse the folder's latest model: the server default may not be usable (it failed once with gpt-5.5).
  const model = toArr(await oc(sessionsURL(1, dir)).catch(() => []))[0]?.model
  const session = (await oc("/api/session", { location: { directory: dir }, ...(model && { model }) })).data
  const t = await tag(session.id, session.location?.directory ?? dir)
  update((s) => (s.last = s.target = session.id))
  // Without text the media stays buffered for the next message, which goes to this new session.
  const m = text ? takeMedia(text) : null
  if (m) await prompt(session.id, m.text, m.images)
  return `已新建 ${t}${m ? `，已发出${m.note}` : "，接着直接发内容就行"}`
}

export async function run(cmd) {
  if (cmd.type === "multi") {
    const out = []
    for (const c of cmd.cmds) out.push(await run(c))
    return out.flat()
  }
  if (cmd.type === "help") return [HELP, await slashHelp().catch((e) => (warn("help:", e), SLASH_HELP))]
  if (cmd.type === "list") return listSessions()
  if (cmd.type === "dirs") {
    const dirs = await listDirs()
    return dirs.length ? `文件夹：\n${dirs.map((d, i) => `${i + 1}. ${dirLabel(d)}`).join("\n")}\n回复「目录 编号」选择` : "没有文件夹"
  }
  if (cmd.type === "cd") {
    const dir = pickDir(state().dirs ?? (await listDirs()), cmd.arg) ?? pickDir(await listDirs(), cmd.arg)
    if (!dir) return `没找到「${cmd.arg}」，发「目录」查看`
    update((s) => (s.dir = dir))
    return `已选中 ${dirLabel(dir)}\n${await listSessions(dir)}\n回复「编号 内容」继续旧对话，「新对话 内容」开新对话`
  }
  if (cmd.type === "new") return newSession(cmd.text)
  if (cmd.type === "image") {
    const file = toPath(cmd.path, dirPath(state().dir))
    if (!file) return /^[a-z][\w+.-]+:/i.test(cmd.path) && !/^file:/i.test(cmd.path) ? "只能发电脑上的文件" : "相对路径要先发「目录」选文件夹"
    await sendImage(file)
    return [] // the image itself is the confirmation
  }
  if (cmd.type === "text" && !cmd.text) return HELP
  if (cmd.type === "live") {
    const key = cmd.n == null ? "*" : sessionOf(cmd.n)
    if (!key) return noNum(cmd.n)
    // liveCmd runs inside update() and only reads the cache, so fill it first (the status lists conversations too).
    for (const k of key === "*" ? Object.keys(state().live ?? {}).filter((k) => k !== "*" && state().nums[k]) : [key]) await tag(k)
    let reply
    update((s) => (reply = liveCmd(s, key, cmd.n, cmd.on)))
    return reply
  }
  // Unnumbered text goes to the session the user last picked, not the last push: other sessions push all the time.
  const sessionID = cmd.n == null ? targetID() : sessionOf(cmd.n)
  if (!sessionID) return cmd.n == null ? HELP : noNum(cmd.n)
  if (cmd.n != null && state().target !== sessionID) update((s) => (s.target = sessionID))
  const n = numOf(sessionID)
  const tg = await tag(sessionID)
  if (cmd.type === "unsend") return sessionID.startsWith(CODEX) ? unsendCodex(cmd, sessionID.slice(CODEX.length), n, tg) : unsendOC(cmd, sessionID, n, tg)
  if (cmd.type === "slash") return sessionID.startsWith(CODEX) ? slashCodex(cmd, sessionID.slice(CODEX.length), tg) : slashOC(cmd, sessionID, n, tg)
  if (sessionID.startsWith(CODEX)) return runCodex(cmd, sessionID.slice(CODEX.length), n, tg)
  if (cmd.type === "show") {
    const session = (await oc(`/api/session/${sid(sessionID)}`)).data
    return `${head(n, session)}\n${clip(await lastReply(sessionID, false), n) || "（还没有回复）"}`
  }
  if (cmd.type === "history") {
    // Tool-only assistant messages are skipped, so fetch extra.
    const limit = Math.min(100, cmd.count * 4 + 10)
    return historyLines((await oc(`/api/session/${sid(sessionID)}/message?limit=${limit}&order=desc`)).data, n, cmd.count, tg)
  }
  const t = cmd.text
  // Approvals need an explicit number, so a casual "好" never approves a request you didn't see.
  const decision = cmd.n == null ? null : YES.test(t) ? "once" : NO.test(t) ? "reject" : null
  const perms = toArr(await oc(`/api/session/${sid(sessionID)}/permission`))
  if (decision && perms.length) {
    await oc(`/api/session/${sid(sessionID)}/permission/${sid(perms[0].id)}/reply`, { decision })
    // A reject also rejects every other pending request of the session.
    if (decision === "reject") return `已拒绝 ${tg}`
    return `已批准 ${tg}${perms.length > 1 ? `，还有 ${perms.length - 1} 个待批准` : ""}`
  }
  // A prompt sent while a form is pending only waits in the inbox and the session stays blocked, so never send one.
  const forms = await formsOf(sessionID)
  if (forms.length) return answerForm(sessionID, n, tg, forms[0], t, { numbered: cmd.n != null, decision: !!decision })
  if (decision) return `${tg} 没有待批准的请求`
  if (noMedia(t)) return noMedia(t)
  const { text, images, note } = takeMedia(t)
  await prompt(sessionID, text, images)
  return `已发给 ${tg}${note}`
}

// Pending forms of a session; drops saved progress once none is pending.
async function formsOf(sessionID) {
  const forms = toArr(await oc(`/api/session/${sid(sessionID)}/form`))
  if (!forms.length && state().forms?.[sessionID]) update((s) => delete s.forms[sessionID])
  return forms
}

// One WeChat message against a pending form: progress is kept in the state file until the last answer, which is
// submitted with every answer in one reply. The result is read back, so a rejected answer is reported.
async function answerForm(sessionID, n, tg, form, text, opts) {
  const a = formAction(form, state().forms?.[sessionID], text, n, { ...opts, tag: tg })
  if (a.save) update((s) => ((s.forms ??= {})[sessionID] = a.save))
  if (a.reply) return a.reply
  const url = `/api/session/${sid(sessionID)}/form/${sid(form.id)}`
  let err = ""
  await (a.cancel ? oc(url, undefined, "DELETE") : oc(`${url}/reply`, { answer: a.submit })).catch((e) => (err = e.message))
  const status = (await oc(url).catch(() => null))?.data?.state?.status
  update((s) => s.forms && delete s.forms[sessionID])
  if (status === (a.cancel ? "cancelled" : "answered")) return a.cancel ? `已忽略 ${tg} 的问题` : `已回答 ${tg}`
  if (status && status !== "pending") return `${tg} 的问题已经在电脑上处理了`
  const why = short(err || `问题的状态是 ${status ?? "未知"}`, 200)
  return `${tg} ${a.cancel ? "忽略" : "提交"}没成功：${why}${status === "pending" ? `\n请重新回答：\n${formText(form, n)}` : ""}`
}

// 「N 撤回」 asks first and remembers what it would take back; 「N 撤回 确认」 within UNSEND_MS does it, if that is still
// the newest message. `plan()` resolves to an unsendPlan, `ask(p)` to the question, `act(p)` to the reply after doing it.
async function unsend(cmd, key, n, tg, plan, ask, act) {
  const p = await plan()
  if (!p) return `${tg} 没有可以撤回的消息`
  if (!cmd.confirm) {
    update((s) => (s.unsend = { key, id: p.id, at: Date.now() }))
    return ask(p)
  }
  const saved = state().unsend
  if (saved) update((s) => delete s.unsend)
  if (saved?.key !== key || Date.now() - saved.at > UNSEND_MS) return `${tg} 没有待确认的撤回（2 分钟内有效），先发「${n} 撤回」`
  if (saved.id !== p.id) return `${tg} 最后一条消息变了，没有撤回；要撤回就重新发「${n} 撤回」`
  return act(p)
}

const undone = (tg, p) => `已撤回 ${tg}「${short(p.text, 30)}」${p.replies ? `及之后的 ${p.replies} 条回复` : ""}`

// What a committed OpenCode revert did to files: its stage result lists the restored files, and has no snapshot
// in a folder OpenCode doesn't snapshot (seen with a folder that isn't a git repo: files stay as they are).
export function revertFiles(r) {
  const f = r?.files ?? []
  if (f.length) return `改过的 ${f.length} 个文件也还原了：${f.slice(0, 5).map((x) => base(x.file)).join("、")}${f.length > 5 ? " 等" : ""}`
  return r?.snapshot ? "这几轮没有改文件" : "改过的文件没有还原（这个文件夹没有快照，通常是因为它不是 git 仓库）"
}

async function unsendOC(cmd, sessionID, n, tg) {
  const url = `/api/session/${sid(sessionID)}`
  if ((await oc(url)).data?.revert) return `${tg} 电脑上有一个撤回还没完成，先在电脑上处理`
  const msgs = async () => toArr(await oc(`${url}/message?limit=50&order=desc`))
  const inbox = async () => toArr(await oc(`${url}/inbox`))
  const running = async () => !!(await oc("/api/session/active")).data?.[sessionID]
  const plan = async () => unsendPlan(await msgs(), await inbox())
  return unsend(cmd, sessionID, n, tg, plan, async (p) => unsendAsk(n, p, p.kind === "revert" && (await running()), tg), async (p) => {
    if (p.kind === "inbox") {
      // Cancelling an item that was delivered meanwhile is a no-op.
      await oc(`${url}/inbox/${sid(p.id)}`, undefined, "DELETE")
      if ((await inbox()).some((i) => i.id === p.id)) return `${tg} 没撤回成功，请在电脑上处理`
      if ((await msgs()).some((m) => m.id === p.id)) return `${tg} 这条已经发给 AI 了，没有撤回；要撤回就再发「${n} 撤回」`
      return `已撤回 ${tg} 还在排队的「${short(p.text, 30)}」`
    }
    if (await running()) {
      await oc(`${url}/interrupt`, {})
      for (let i = 0; i < 20 && (await running()); i++) await new Promise((r) => setTimeout(r, 500))
    }
    const r = (await oc(`${url}/revert/stage`, { messageID: p.id, files: true })).data
    await oc(`${url}/revert/commit`, {})
    return `${undone(tg, p)}；${revertFiles(r)}`
  })
}

// Codex: thread/revert on the plugin's app-server, so not for a thread a window or terminal has open.
async function unsendCodex(cmd, threadId, n, tg) {
  if (bridge().running(threadId)) return `${tg} 正在运行，先发「${n} /stop」再撤回`
  if (await desktopOwns(threadId).catch(() => false)) return `${tg} 在电脑上的 Codex 窗口里打开着，请在窗口里操作`
  const plan = async () => codexUnsendPlan(await bridge().turns(threadId, 10))
  return unsend(cmd, CODEX + threadId, n, tg, plan, (p) => unsendAsk(n, p, false, tg), async (p) => {
    try {
      await bridge().revert(threadId, p.id)
    } catch (e) {
      if (e.message === BUSY) return `${tg} ${BUSY}`
      throw e
    }
    return `${undone(tg, p)}；Codex 只撤回对话记录，改过的文件不会还原`
  })
}

const targetID = () => state().target ?? state().last

// Buffered WeChat media for the prompt being sent now; the buffer is emptied. Media past PAIR_MS is dropped.
// ponytail: emptied before the prompt is sent, so a failed prompt loses the images; resend them if that bites.
function takeMedia(text) {
  const items = liveMedia(g.media)
  g.media = []
  const r = withMedia(text, items)
  const imgs = r.images.length
  const files = items.length - imgs
  const note = items.length ? `（带了${[imgs && `${imgs} 张图片`, files && `${files} 个文件`].filter(Boolean).join("、")}）` : ""
  return { ...r, note }
}

// Splits list lines into messages under the WeChat push size.
export function chunkLines(lines, max = CHUNK_CHARS) {
  const out = [""]
  for (const l of lines) {
    if (out.at(-1) && out.at(-1).length + l.length + 1 > max) out.push("")
    out[out.length - 1] += (out.at(-1) ? "\n" : "") + l
  }
  return out.filter(Boolean)
}

// Model list, or a switch to models[pick]. `current` is the label of the model in use.
function modelReply(tg, models, current, arg, apply, note) {
  if (!models.length) return `${tg} 没有可用的模型`
  const footer = "回复「/model 编号」或「/model 名字」切换"
  if (!arg) return chunkLines([`${tg} 可用模型（共 ${models.length} 个）：`, ...modelLines(models, current), footer])
  const found = pickModel(models, arg)
  if (!found.length) return `${tg} 没找到模型「${arg}」，发「/model」查看`
  if (found.length > 1) {
    const lines = modelLines(models, current).filter((_, i) => found.includes(models[i]))
    return chunkLines([`${tg} 有 ${found.length} 个匹配「${arg}」，回「/model 编号」选一个：`, ...lines.slice(0, 30)])
  }
  return apply(found[0]).then(() => `已把 ${tg} 切到 ${found[0].label}${note ?? ""}`)
}

async function slashOC(cmd, sessionID, n, tg) {
  const name = cmd.name.toLowerCase()
  const session = (await oc(`/api/session/${sid(sessionID)}`)).data
  const loc = `location[directory]=${encodeURIComponent(session?.location?.directory ?? "")}`
  if (name === "model") {
    const models = toArr(await oc(`/api/model?${loc}`))
      .filter((m) => m.enabled && m.status !== "deprecated")
      .map((m) => ({ id: m.id, providerID: m.providerID, label: `${m.providerID}/${m.id}`, name: m.name, image: m.capabilities?.input?.includes("image") }))
      .sort((a, b) => a.label.localeCompare(b.label))
    const cur = session?.model && `${session.model.providerID}/${session.model.id}`
    return modelReply(tg, models, cur, cmd.args, (m) => oc(`/api/session/${sid(sessionID)}/model`, { model: { id: m.id, providerID: m.providerID } }), "（这个对话之后都用它，桌面端也是）")
  }
  if (name === "stop") {
    const r = await oc(`/api/session/${sid(sessionID)}/interrupt`, {})
    return r?.interrupted ? `已停止 ${tg}` : `${tg} 没有在运行`
  }
  // Compactions and commands would wait in the inbox behind the form, like a prompt.
  if ((await formsOf(sessionID)).length) return `${tg} 在等你回答问题，回答或发「${n} 忽略」`
  if (name === "compact") {
    await oc(`/api/session/${sid(sessionID)}/compact`, {})
    return `${tg} 开始压缩上下文`
  }
  const cmds = toArr(await oc(`/api/command?${loc}`)).map((c) => c.name)
  const known = cmds.find((c) => c.toLowerCase() === name)
  if (!known) return `不认识的命令 /${cmd.name}，发「帮助」查看${cmds.length ? `\nOpenCode 命令：${cmds.map((c) => "/" + c).join(" ")}` : ""}`
  const { text, images, note } = takeMedia(cmd.args)
  await oc(`/api/session/${sid(sessionID)}/command`, {
    name: known,
    text,
    ...(images.length && { files: images.map((p) => ({ uri: pathToFileURL(p).href, name: path.basename(p) })) }),
  })
  return `已在 ${tg} 运行 /${known}${note}`
}

async function slashCodex(cmd, threadId, tg) {
  const name = cmd.name.toLowerCase()
  if (name === "model") {
    const models = (await bridge().models())
      .filter((m) => !m.hidden)
      .map((m) => ({ id: m.model, label: m.model, name: m.displayName, image: m.inputModalities?.includes("image") ?? true }))
    const cur = state().codexModels?.[threadId] ?? (await codexThread(threadId))?.model
    return modelReply(tg, models, cur, cmd.args, async (m) => update((s) => ((s.codexModels ??= {})[threadId] = m.id)),
      "（从微信发出的每一轮都带上它，下一轮生效；Codex 会把它记成这个对话之后的模型）")
  }
  if (name === "stop") {
    if (await bridge().interrupt(threadId)) return `已停止 ${tg}`
    const r = await desktopInterrupt(threadId).catch((e) => (warn("codex desktop stop:", e), null))
    if (r) return `已停止 ${tg}（电脑上的 Codex 窗口）`
    return r === "" ? `${tg} 没有在运行` : `${tg} 没有在运行（在终端里跑的只能在电脑上停）`
  }
  if (name === "compact") {
    if (await desktopCompact(threadId).catch((e) => (warn("codex desktop compact:", e), false))) return `${tg} 开始压缩上下文（电脑上的 Codex 窗口）`
    try {
      await bridge().compact(threadId)
    } catch (e) {
      if (e.message === BUSY) return `${tg} ${BUSY}`
      throw e
    }
    return `${tg} 开始压缩上下文，完成后推送`
  }
  return `不认识的命令 /${cmd.name}，发「帮助」查看（Codex 对话支持 /model /stop /compact）`
}

// Codex approval records written by codex-hook.js, oldest first; records past PENDING_TTL are deleted.
// `done` records are ones the computer already handled; answered ones (with an .answer file) are left out.
export function readPending(dir = PENDING_DIR, now = Date.now()) {
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {}
  const out = []
  for (const f of names.filter((f) => f.endsWith(".json") && !names.includes(f.replace(/\.json$/, ".answer")))) {
    const p = readJson(path.join(dir, f))
    if (!p?.id) continue
    if (now - p.created > PENDING_TTL) fs.rmSync(path.join(dir, f), { force: true })
    else out.push(p)
  }
  return out.sort((a, b) => a.created - b.created)
}

const dropPending = (ps, dir = PENDING_DIR) => ps.forEach((p) => fs.rmSync(path.join(dir, `${p.id}.json`), { force: true }))

// Answers the waiting terminal hooks of [n] (allow: the oldest, deny: all) by writing <id>.answer. Returns their ids.
export function answerCodex(pending, n, decision, dir = PENDING_DIR) {
  const mine = pending.filter((p) => p.n === n && !p.done && (p.mode ?? "wait") === "wait")
  const picked = decision === "allow" ? mine.slice(0, 1) : mine
  for (const p of picked) fs.writeFileSync(path.join(dir, `${p.id}.answer`), decision)
  return picked.map((p) => p.id)
}

// 「N y」/「N n」 for a Codex thread: our own turn, a waiting terminal hook, or the desktop window.
async function approveCodex(threadId, n, tg, allow) {
  const verb = allow ? "已批准" : "已拒绝"
  const mine = readPending().filter((p) => p.threadId === threadId)
  let count = bridge().approve(threadId, allow)
  if (!count) count = answerCodex(mine, n, allow ? "allow" : "deny").length
  if (!count && mine.some((p) => p.mode === "desktop" && !p.done)) count = (await desktopApprove(threadId, allow)) ?? 0
  if (count) {
    // Desktop and bridge records only exist to route the answer; the terminal hook removes its own.
    dropPending(mine.filter((p) => p.mode !== "wait").slice(0, allow ? 1 : undefined))
    return `${verb} ${tg}`
  }
  if (mine.length) {
    dropPending(mine.filter((p) => p.mode !== "wait" || p.done))
    return "已经在电脑上处理了"
  }
  return `${tg} 没有待批准的请求`
}

async function runCodex(cmd, threadId, n, tg) {
  const head = async () => codexHead(n, "", await codexThread(threadId), { base, short })
  if (cmd.type === "show") {
    const reply = replyText(codexMsgs(await bridge().turns(threadId, 3)), false)
    return `${await head()}\n${clip(reply, n) || "（还没有回复）"}`
  }
  if (cmd.type === "history") return historyLines(codexMsgs(await bridge().turns(threadId, cmd.count + 2)), n, cmd.count, tg)
  const t = cmd.text
  if (cmd.n != null && (YES.test(t) || NO.test(t))) return approveCodex(threadId, n, tg, YES.test(t))
  // A question: held by our own app-server, or shown in the desktop window (the hook left a record).
  const answered =
    bridge().reply(threadId, t, n, tg) ??
    (await desktopReply(threadId, t, n, tg, { dir: PENDING_DIR }).catch((e) => `${tg} 回答没有送达：${short(e?.message, 150)}`))
  if (answered) return answered
  if (noMedia(t)) return noMedia(t)
  // An async question (request_user_input_async) in the thread: send the text as its answer, in the window's format.
  const ask = await asyncQuestion.asyncAnswer?.(threadId, t, n, tg).catch((e) => (warn("codex async question:", e), null))
  if (ask?.reply) return ask.reply
  const { text, images, note } = takeMedia(ask?.text ?? t)
  const opts = { images, model: state().codexModels?.[threadId] }
  const sent = ask ? "已作为回答发给" : "已发给"
  try {
    if (!bridge().running(threadId) && (await desktopSend(threadId, text, undefined, opts).catch((e) => (warn("codex desktop send:", e), false))))
      return `${sent} ${tg}${note}（电脑上的 Codex 窗口里能看到）`
    await bridge().send(threadId, text, opts)
  } catch (e) {
    if (e.message === BUSY) return `${tg} ${BUSY}`
    throw e
  }
  return `${sent} ${tg}${note}（在后台运行，回复完成会推送；桌面端重新打开这个对话能看到）`
}

// 「发」 / 「3 图」 with nothing buffered: say so instead of sending the word to the AI.
const noMedia = (t) => (SEND_WORD.test(t.trim()) && !liveMedia(g.media).length ? "没有待发的图片或文件（10 分钟内发来的才算）" : null)

// Pushes for turns the bridge runs, same text as the Codex hooks and the OpenCode pushes.
export function codexPushText(head, n, kind, text) {
  if (kind === "done") return `${head}\n${clip(text, n) || "完成（没有文字回复）"}`
  if (kind === "failed") return `${head}\n出错：${short(text, 300)}`
  if (kind === "approval") return `${head}\n等你批准：${short(text, 300)}\n回复「${n} y」批准，「${n} n」拒绝（这个对话在后台运行，只能在微信里批准）`
  return `${head}\n${text}`
}

// Called synchronously in the order the app-server reports, so progress bookkeeping keeps that order.
function codexPush(threadId, kind, text) {
  const key = CODEX + threadId
  const info = async () => {
    const thread = await codexThread(threadId)
    remember(key, cleanDir(thread?.cwd))
    return { head: codexHead(await assign(key), "", thread, { base, short }) }
  }
  if (kind === "text") return addText(key, text, info)
  if (kind === "tool") return addTool(key, text, info)
  const live = takeLive(key, kind !== "approval" && kind !== "question", liveOn(state(), key))
  if (kind !== "end") return codexSend(threadId, kind, text, live).catch((e) => warn("codex push:", e))
}

async function codexSend(threadId, kind, text, live) {
  const key = CODEX + threadId
  const n = await assign(key)
  const thread = await codexThread(threadId)
  remember(key, cleanDir(thread?.cwd))
  if (kind === "question") text = formText(questionForm(text), n, false)
  const h = codexHead(n, "", thread, { base, short })
  let msg = kind === "done" ? doneText(h, n, text, live, tagIn(state(), key, n)) : withPre(codexPushText(h, n, kind, text), live)
  const { files, big } = kind === "done" ? await replyImages(text, cleanDir(thread?.cwd)) : { files: [], big: [] }
  if (big.length) msg += `\n（图片太大没发：${big.join("、")}）`
  await push(key, msg)
  for (const f of files) await sendImage(f).catch((e) => warn("image:", e))
}

// One app-server bridge per process; a hot-reloaded module stops the old one (it would still run old code).
function bridge() {
  if (g.bridge?.gen !== GEN) {
    g.bridge?.stop()
    g.bridge = createBridge({
      markerDir: PENDING_DIR,
      push: codexPush,
    })
    g.bridge.gen = GEN
  }
  return g.bridge
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

// Downloads a message's images and files into the buffer; returns the ack text.
async function bufferMedia(items) {
  let failed = 0
  for (const d of items) {
    try {
      g.media = [...liveMedia(g.media), { ...(await saveMedia(d)), at: Date.now() }]
    } catch (e) {
      failed++
      warn("inbound media:", e)
    }
  }
  const id = targetID()
  return mediaAck(liveMedia(g.media), id && (await tag(id)), failed)
}

// Handles one polled message. `out` sends each reply (exported with it so a check can run without WeChat).
export async function inbound(msg, floor, out = send) {
  const account = readJson(path.join(DIR, "account.json"))
  const text = inboundText(msg, account?.userId)
  const media = inboundMedia(msg, account?.userId)
  if (text == null && !media.length) return
  // A message from the user brings a fresh context_token, and with it a fresh allowance of bot messages.
  if (msg.context_token && (msg.context_token !== state().contextToken || state().sent)) {
    update((s) => ((s.contextToken = msg.context_token), (s.sent = 0)))
  }
  // Drop backlog: without a saved cursor the first poll can return old messages, and stale commands are risky.
  const created = Number(msg.create_time_ms ?? 0)
  if (created && created < floor()) return
  const key = msg.message_id ?? `${msg.client_id}:${created}`
  if (g.handled.has(key)) return
  g.handled.add(key)
  if (g.handled.size > 200) g.handled.delete(g.handled.values().next().value)
  // A photo and its caption arrive as separate messages: media waits in g.media for the next text.
  const ack = media.length ? await bufferMedia(media) : ""
  const reply = text == null ? ack : await run(parseCommand(text)).catch((e) => `出错了：${short(e?.message, 150)}`)
  // run() returns a string, or an array sent one message at a time (spaced out so WeChat doesn't throttle).
  for (const [i, r] of [reply].flat().filter(Boolean).entries()) {
    if (i) await new Promise((resolve) => setTimeout(resolve, 300))
    await out(r)
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
    // Hot reload: the old module's app-server would keep running old code.
    if (g.bridge && g.bridge.gen !== GEN) (g.bridge.stop(), (g.bridge = null))
    const handle = async (event) => {
      if (!TYPES.has(event?.type)) return
      const sessionID = sessionIDOf(event)
      if (!sessionID || !shouldSend(eventKey(event))) return
      const getSession = () => ctx.session.get({ sessionID }).catch(() => undefined)
      const info = async () => {
        const s = await getSession()
        if (s?.parentID) return { child: true }
        remember(sessionID, s?.location?.directory ?? event.location?.directory)
        return { head: head(await assign(sessionID), s, event.location?.directory) }
      }
      if (event.type === "session.text.ended") return addText(sessionID, event.data?.text, info)
      if (event.type === "session.tool.input.started") return addTool(sessionID, event.data?.name, info)
      // Synchronous up to here: every instance sees events in order, so whichever instance handles the end of a run
      // has already seen (and someone has recorded) each segment before it.
      let live = takeLive(sessionID, ENDS.has(event.type), liveOn(state(), sessionID))
      if (event.type === "session.execution.interrupted") return
      const session = await getSession()
      if (session?.parentID) live = NO_LIVE
      if (event.type === "session.execution.succeeded" && session?.parentID) return
      const reply =
        event.type === "session.execution.succeeded" ? await lastReply(sessionID).catch((e) => (warn(e), "")) : ""
      remember(sessionID, session?.location?.directory ?? event.location?.directory)
      let text = format(event, session, await assign(sessionID), reply, live)
      if (!text) return
      if (event.type !== "session.execution.succeeded") text = withPre(text, live)
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
        g.bridge?.stop()
        g.bridge = null
      }
    }
  },
}
