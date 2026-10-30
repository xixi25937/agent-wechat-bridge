import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  BUSY, bridgeMarker, cleanDir, codexDirs, codexHead, codexMsgs, codexThread, codexThreads, createBridge, desktopApprove, desktopCompact, desktopInterrupt,
  desktopOwns, desktopSend,
} from "./codex.js"
// Namespace import: a hot reload can pair this file with an older codex.js that lacks codexHistory / warm.
import * as codexMod from "./codex.js"
import { desktopReply, readQuestion } from "./codex-question.js"
// Namespace import: a hot reload can pair this file with an older codex-question.js that lacks asyncAnswer.
import * as asyncQuestion from "./codex-question.js"
import { NO, YES, formAction, formText, questionForm } from "./form.js"
import {
  FILE_MAX_BYTES, IMG, candidates, diffPaths, fileChangePaths, fileItem, liveOffer, mentionedPaths, offerText, parseSelection, resolveSelection, toPath, toolPaths,
} from "./files.js"
import { md, numbered, ul } from "./md.js"
import { pollLock, readLock } from "./poll-lock.js"
import {
  FLUSH, HIGH, LOW, QUOTA, REPLY, RESERVE, alive, decide, enqueue, expire, foldOffer, groups, left, liveMs, lostNote, mergeTexts, noticeText, quotaText, skipNote,
} from "./quota.js"

// session.idle exists in the client types but 2.0.32 never emits it; a finished run is session.execution.succeeded.
const TYPES = new Set([
  "session.execution.succeeded", "session.execution.failed", "permission.asked", "form.created",
  "session.text.ended", "session.tool.input.started", "session.execution.interrupted",
])
const ENDS = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])
const DEBOUNCE_MS = 5000
// Longer text is cut here and ends with how much is left; up to that it goes out in chunks of CHUNK_CHARS.
const MAX_CHARS = 8000
// One WeChat message holds this many characters. A third-party report (hermes-agent) says iLink cuts or rejects text past
// ~2000; a real sendmessage of 4516 characters (12.4 KB of UTF-8) came back ret=0 (probe-send-limits.js, 2026-10-30), so
// this is 3500: verified by the API, not on the phone yet. If the phone shows a cut message, set WECHAT_NOTIFY_CHUNK=1800.
const CHUNK_CHARS = Number(process.env.WECHAT_NOTIFY_CHUNK) || 3500
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
const SERVICE_FILE = process.env.OPENCODE_SERVICE_FILE || path.join(os.homedir(), ".local", "state", "opencode", "service.json")
// What a reply says when an OpenCode conversation is addressed but no OpenCode service runs (Codex-only daemon).
const OC_DOWN = "OpenCode 没在运行，打开 OpenCode 后再试"
const STATUS = { succeeded: "完成", failed: "出错", interrupted: "中断" }
const section = (title, items) => md(`【${title}】`, ul(items))
// Short sections of one-line bullets: WeChat shows the text as Markdown (see md.js).
export const HELP = md(
  section("发消息", ["3 内容 → 发给 [3] 号对话", "直接发内容 → 发给上次的对话", "回复会标明发给了谁"]),
  section("看对话", ["3 → 再看 [3] 的最后回复", "3 历史 10 → 最近 10 条消息", "历史默认 5 条，最多 20", "列表 → 最近的对话和编号", "对话 24 小时没用，编号回收"]),
  section("批准和回答", ["3 y / 3 n → 批准 / 拒绝", "3 答案 → 回答 [3] 的提问", "几个问题可一行一个回完", "「-」跳过，「3 忽略」不答"]),
  section("文件夹和新对话", ["目录 → 列出文件夹", "目录 2 → 选第 2 个并列出对话", "新对话 内容 → 在选中的文件夹新建", "标着 Codex 的文件夹开 Codex 对话"]),
  section("图片", ["图 路径 → 把电脑上的图发来", "相对路径按选中的文件夹算", "发图片/文件 → 先存着", "下一条文字带上它们一起发", "不用说明就回「发」或「3 图」", "10 分钟内有效"]),
  section("文件", ["每轮结束后列出这轮的文件", "3 文件 1 3 → 发第 1、3 个", "3 文件 全部 → 全部发来", "文件 路径 → 发电脑上的文件", "文件提示 关 / 开 → 关 / 开"]),
  section("撤回", ["3 撤回 → 撤回 [3] 最后一条", "再发「3 撤回 确认」才执行", "不带编号就是当前对话", "也认 /unsend"]),
  section("实时推送", ["实时 关 / 实时 开 → 关 / 开", "回复过程中约 15 秒推一条", "3 实时 关 → 只关 [3]", "实时 → 看状态"]),
  section("暂停服务", ["/stop → 暂停推送和微信命令", "也关掉 Codex 后台程序", "/start → 恢复并重新打开", "暂停时只认 /start 帮助 额度", "3 /stop → 只停 [3] 的回复"]),
  section("其他", ["编号后是 agent 和目录", "例：[3] OpenCode · ttool", "OpenCode 和 Codex 用法一样", "额度 → 看微信发送额度", "/ 命令 → 见下一条"]),
)

export function slashHelpText(t, commands) {
  return md(
    `【/ 命令】发给当前对话${t ? ` ${t}` : ""}`,
    ul(["/model → 列出模型", "/model 3 → 切到第 3 个", "/model 名字 → 按名字切换", "3 /stop → 停止 [3] 的回复", "/stop 不带编号 → 暂停服务", "/compact → 压缩上下文", "「3 /compact」指定对话"]),
    commands?.length && md("【OpenCode 自带命令】", ul(commands.map((c) => `/${c.name}${c.description ? ` → ${short(c.description, 50)}` : ""}`))),
  )
}
const SLASH_HELP = slashHelpText()
// The slash list for the current target: OpenCode commands depend on the session's folder (plugins, skills).
async function slashHelp() {
  const sessionID = targetID()
  if (!sessionID) return SLASH_HELP
  const t = await tag(sessionID)
  if (sessionID.startsWith(CODEX)) return md(slashHelpText(t), "（Codex 对话只支持 /model、N /stop、/compact）")
  const session = (await oc(`/api/session/${sid(sessionID)}`)).data
  const loc = `location[directory]=${encodeURIComponent(session?.location?.directory ?? "")}`
  return slashHelpText(t, toArr(await oc(`/api/command?${loc}`)))
}
const MAX_IMAGES = 4
const IMAGE_MAX_BYTES = 10 * 1024 * 1024
const TOO_BIG = "太大（超过 10 MB）"
// WECHAT_NOTIFY_CDN: a test seam (a fake CDN); the real one never changes.
const CDN = process.env.WECHAT_NOTIFY_CDN || "https://novac2c.cdn.weixin.qq.com/c2c"
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
  // OpenCode being closed is expected when the daemon runs alone; the reply already says so.
  if (a.some((x) => x?.down)) return
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
  return `${t.slice(0, max)}\n\n…（还有 ${t.length - max} 字，${n == null ? "" : `发「${n} 历史 1」或`}看桌面端）`
}

// One WeChat message per chunk of about `size` characters, cut at a paragraph or line break when one is in the
// second half of the chunk, never before an indented line (the next chunk would open a nested item or code block with
// it). Chunks are numbered "(1/3)": on the first line of the first when it carries the full "[N] OpenCode · 目录" tag,
// otherwise in a line of its own; the others start with the short "[N] (2/3)" and a blank line.
export function splitText(text, size = CHUNK_CHARS) {
  let rest = String(text ?? "")
  if (rest.length <= size) return [rest]
  const parts = []
  const breakAt = (win, sep) => {
    let i = win.lastIndexOf(sep)
    while (i >= size / 2 && /^[ \t]/.test(rest.slice(i + sep.length, i + sep.length + 1))) i = win.lastIndexOf(sep, i - 1)
    return i
  }
  while (rest.length > size) {
    const win = rest.slice(0, size)
    let cut = breakAt(win, "\n\n")
    if (cut < size / 2) cut = breakAt(win, "\n")
    if (cut < size / 2) cut = /[\ud800-\udbff]/.test(win.at(-1)) ? size - 1 : size
    parts.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).replace(/^\n+/, "")
  }
  if (rest.trim()) parts.push(rest)
  const k = parts.length
  if (k === 1) return parts
  const tag = parts[0].match(/^\[\d+\]/)?.[0]
  return parts.map((p, i) => (i ? `${tag ? tag + " " : ""}(${i + 1}/${k})\n\n${p}` : tag ? p.replace(/^.*/, (l) => `${l} (1/${k})`) : `(1/${k})\n\n${p}`))
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
      .join("\n\n")
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
  md(
    `${t} 将撤回${p.kind === "inbox" ? "还在排队的" : ""}「${short(p.text, 30)}」${p.replies ? `及之后的 ${p.replies} 条回复` : ""}${running ? "（会先停止正在运行的回复）" : ""}`,
    `确认发「${n} 撤回 确认」（2 分钟内有效）`,
  )

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
    const text = parts.filter((c) => c.type === "text").map((c) => c.text).join("\n\n").trim()
    if (m.type === "user") {
      tools = new Map()
      const t = userText(m)
      if (t) items.push(md("你：", clip(t)))
    } else if (m.type === "assistant") {
      for (const c of parts) if (c.type === "tool") tools.set(c.name, (tools.get(c.name) ?? 0) + 1)
      if (!text) continue
      const u = used(tools)
      items.push(md("AI：", clip(text), u && `（调用了 ${u}）`))
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
  switch (event.type) {
    case "session.execution.succeeded":
      return session?.parentID ? null : doneText(hd, n, reply, live, ocTag(n, session, event.location?.directory))
    case "session.execution.failed":
      return withSkip(md(hd, "出错：" + short(d.error?.message || d.error?.type || "未知错误", 300)), live, n)
    case "permission.asked": {
      const what = d.message || [d.action, ...(d.resources ?? [])].filter(Boolean).join(" ")
      return md(hd, `等你批准：${short(what, 300)}`, `回复「${n} y」批准一次，「${n} n」拒绝`)
    }
    case "form.created":
      return md(hd, formText(d.form, n))
  }
  return null
}

// Live progress (see takeLive): `live` is { body, pushed }, the text not pushed yet and whether any of the run was.
// A run that pushed progress ends with only what wasn't pushed, or one line when nothing is left; any other run
// ends with its last reply, as without progress. `t`: the conversation's tag, for the one-line ending.
// Progress left out near the end of the allowance (`live.skipped` segments) is not in the push, so the run ends with
// its last reply, and says how many segments were skipped.
export const doneText = (h, n, reply, live, t = `[${n}]`) =>
  live?.skipped
    ? md(h, clip(live.body || reply, n) || "完成（没有文字回复）", skipNote(live.skipped, n))
    : !live?.pushed ? md(h, clip(reply, n) || "完成（没有文字回复）") : live.body ? md(h, clip(live.body, n)) : `${t} 完成`

// A failed run's message also says how many progress segments were skipped.
export const withSkip = (msg, live, n) => (live?.skipped ? md(msg, skipNote(live.skipped, n)) : msg)

// Errors, approvals and questions carry the pending progress first (after the header paragraph), so order is kept.
export function withPre(msg, live) {
  if (!live?.body) return msg
  const i = msg.indexOf("\n\n") < 0 ? msg.length : msg.indexOf("\n\n")
  return `${msg.slice(0, i)}\n\n${clip(live.body)}${msg.slice(i)}`
}

// Body of a progress push: the text segments finished since the last push, then the tools called since then.
// Empty without text: a tool summary alone waits for the next text.
export function liveBody(texts, tools) {
  const t = texts.map((s) => s.trim()).filter(Boolean).join("\n\n")
  const u = used(tools ?? [])
  return t && md(t, u && `（调用了 ${u}）`)
}

// Wait before the next progress push of a conversation whose last push (or first segment) was at `at`; `sent`: bot
// messages used so far (see liveMs).
export const liveDelay = (at, now = Date.now(), sent = 0) => Math.max(0, at + liveMs(sent) - now)

// Whether a conversation gets progress pushes: its own 「N 实时 开/关」, else the global one, else on.
export const liveOn = (s, key) => s.live?.[key] ?? s.live?.["*"] ?? true

// Reply to 「实时」: status with `on` undefined, else the switch. `key` is the session key, or "*" for all.
export function liveCmd(s, key, n, on) {
  const word = (v) => (v ? "开" : "关")
  if (on == null) {
    if (key !== "*") return `${tagIn(s, key, n)} 实时推送：${word(liveOn(s, key))}`
    const all = liveOn(s, "*")
    const other = Object.entries(s.live ?? {}).filter(([k, v]) => k !== "*" && v !== all && s.nums[k]).map(([k]) => tagIn(s, k))
    return md(
      `实时推送：${word(all)}${other.length ? `（${other.join("、")} ${word(!all)}）` : ""}`,
      "「实时 关」/「实时 开」切换所有对话，「编号 实时 关」只切换一个",
    )
  }
  if (key === "*") s.live = { "*": on }
  else (s.live ??= {})[key] = on
  return `${key === "*" ? "所有对话的" : `${tagIn(s, key, n)} 的`}实时推送已${on ? "打开" : "关闭"}${on ? "" : "，回复完成时照常推送"}`
}

const KEYWORDS = [
  ["list", /^(列表|\/?list|\/ls)$/i],
  ["help", /^(帮助|\/?help|\?|？|\/|／)$/i],
  ["dirs", /^(目录|文件夹|\/?dirs?)$/i],
  ["quota", /^(额度|\/quota)$/i],
]
export const PAUSED_TEXT = "已暂停：不再推送，也不执行微信命令。发 /start 恢复"
// The same when the Codex background program was running: "closed" (stopped now) or "later" (a reply of ours is still running).
export const pausedText = (codex) =>
  codex ? `已暂停：不再推送，也不执行微信命令，Codex 后台程序${codex === "later" ? "等正在跑的回复结束后关闭" : "也关闭"}。发 /start 恢复` : PAUSED_TEXT
// What a paused bridge still hears: 「/start」, 「帮助」, 「额度」 (and 「/stop」 again, to confirm).
const HEARD_PAUSED = new Set(["resume", "pause", "help", "quota"])
export const heardWhilePaused = (cmd) => !!cmd && (cmd.type === "multi" ? cmd.cmds.every(heardWhilePaused) : HEARD_PAUSED.has(cmd.type))
const OWN_SLASH = new Set(["list", "ls", "help", "dir", "dirs", "cd", "new", "history", "img", "live", "unsend", "file", "files", "quota"])
// What 「文件 …」 treats as a path rather than chat: a separator, or an extension with a letter ("v1.2" is not one).
const PATHISH = /[\\/]|\.\w*[a-z]\w*$/i
const keyword = (w) => KEYWORDS.find(([, re]) => re.test(w) || re.test(w.replace(/[。.！!？?~～…]+$/, "")))?.[0]

export function parseCommand(text) {
  const t = String(text ?? "").trim()
  // Pause / resume the whole bridge. Without a number only: "3 /stop" stops conversation 3's reply (the slash rule below).
  // 「开始」 may also be an answer to the agent, so it resumes only while paused (`soft`, see inbound).
  if (/^(?:\/stop|停止服务)[。.！!]*$/i.test(t)) return { type: "pause" }
  if (/^(?:\/start|启动服务)[。.！!]*$/i.test(t)) return { type: "resume" }
  if (/^开始[。.！!]*$/.test(t)) return { type: "resume", soft: true }
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
  // 「文件提示 关」「/files off」. "文件提示怎么改" stays a normal message.
  m = t.match(/^(?:文件提示|\/files)(?:\s*(开|关|on|off))?$/i)
  if (m) return { type: "filehint", ...(m[1] && { on: /^(开|on)$/i.test(m[1]) }) }
  // 「3 文件 1 3」「3 文件 全部」「3 文件」, without the number for the current conversation; 「文件 路径」/「/file 路径」
  // sends a path. "文件夹里有什么" and "5 文件名改一下" have no space after 文件, "5 文件 帮我看看" is not a selection,
  // and 「文件 太大了」 has no extension: all normal messages.
  m = t.match(/^(?:(\d{1,4})\s*)?(文件|\/file)(?:\s+([\s\S]+))?$/i)
  if (m) {
    const arg = m[3]?.trim()
    const sel = arg && parseSelection(arg)
    const n = m[1] && { n: Number(m[1]) }
    if (!arg || sel) return { type: "files", ...n, ...(sel && { sel }) }
    const file = arg.replace(/^[`"'“「]+|[`"'”」]+$/g, "")
    if (m[2][0] === "/" || (!m[1] && PATHISH.test(file))) return { type: "file", path: file }
  }
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
  return md(bad, `收到${what}`, `接着发文字说明，${to}（不用说明就回「发」）`)
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
  models.map((m, i) => `${i + 1} ${m.label}${m.label === current ? " ← 当前" : ""}${m.image ? "" : "（不看图）"}`)

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
export const state = () => ({ nums: {}, ...readJson(STATE_FILE) })
// Whether the bridge is paused (WeChat 「/stop」, until 「/start」): kept in the state file so it holds across restarts and
// for the Codex hook processes, which check it before they wait for WeChat.
export const paused = () => !!state().paused

// The plugin, the daemon and the Codex hooks all write the state (send count, outbox), so a read-modify-write holds
// DIR/state.lock (created exclusively; a lock older than LOCK_STALE_MS is a crashed holder's). It gives up after
// LOCK_WAIT_MS and writes anyway: a stuck lock must not stop messages.
// ponytail: two contenders that both find the same stale lock can both take it; add a guard file like poll-lock.js if it shows up.
const LOCK_FILE = path.join(DIR, "state.lock")
const LOCK_STALE_MS = 5000
const LOCK_WAIT_MS = 2000
const nap = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    for (const end = Date.now() + ms; Date.now() < end; );
  }
}
let holding = false
function takeLock() {
  for (const end = Date.now() + LOCK_WAIT_MS; ; nap(10)) {
    try {
      fs.closeSync(fs.openSync(LOCK_FILE, "wx"))
      return true
    } catch (e) {
      // Windows answers EPERM / EBUSY while the holder is deleting the file.
      if (!["EEXIST", "EPERM", "EBUSY", "EACCES"].includes(e.code)) return false
      try {
        if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS) fs.rmSync(LOCK_FILE, { force: true })
      } catch {}
      if (Date.now() > end) return false
    }
  }
}

export function update(fn) {
  const own = !holding && takeLock()
  if (own) holding = true
  try {
    const s = state()
    fn(s)
    try {
      // Write then rename, so another process never reads a half-written file and saves defaults over it.
      const tmp = `${STATE_FILE}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(s))
      // Windows refuses to replace a file another process is reading that very moment.
      for (let i = 0; ; i++) {
        try {
          fs.renameSync(tmp, STATE_FILE)
          break
        } catch (e) {
          if (i >= 4) throw e
          nap(15)
        }
      }
    } catch (e) {
      warn("state save failed:", e)
    }
    return s
  } finally {
    if (own) {
      holding = false
      fs.rmSync(LOCK_FILE, { force: true })
    }
  }
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
      delete s.offers?.[k]
      if (k.startsWith(CODEX)) delete s.codexModels?.[k.slice(CODEX.length)]
    }
    for (const k of Object.keys(s.offers ?? {})) if (!liveOffer(s.offers[k], now)) delete s.offers[k]
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
  const hint = ret === -2 ? " (context_token 过期，或你上一条消息之后机器人已经发满额度，给机器人发一条消息就恢复)" : ""
  // `rejected`: iLink answered, so retrying the same request is pointless (a network failure has no such flag).
  throw Object.assign(new Error(`${name} failed: ${status} ${short(json.errmsg ?? "", 120)}${hint}`), { rejected: true })
}

function recipient() {
  const account = readJson(path.join(DIR, "account.json"))
  const tokens = readJson(path.join(DIR, "context_tokens.json")) ?? {}
  const to = account?.userId
  const contextToken = state().contextToken ?? tokens[to] ?? Object.values(tokens).pop()
  if (!to || !contextToken) throw new Error(`credentials missing in ${DIR}`)
  return { to, contextToken }
}

// iLink answers ret=-2 with "prepare failed" for a stale context_token, a burst of sends, and once a token has carried
// ~10 bot messages (see quota.js); with "invalid arguments" for a request it rejects (two text items in one
// sendmessage, seen 2026-10-30). Only the first is the allowance running out.
const spent = (json) => Number(json.ret) === -2 && !/invalid arg/i.test(json.errmsg ?? "")
// One retry after a pause covers a burst, and picks up a token that arrived meanwhile. WECHAT_NOTIFY_RETRY_MS: a test seam.
const RETRY_MS = Number(process.env.WECHAT_NOTIFY_RETRY_MS) || 2000
const QUEUED = "queued"
const SKIPPED = "skipped"
const PAUSED = "paused"
const textItems = (text) => [{ type: 1, text_item: { text } }]
const gap = () => new Promise((r) => setTimeout(r, CHUNK_GAP_MS))

// One sendmessage, with the budget already claimed. Returns its status, or null when iLink says the allowance is spent
// (after one retry). Throws on any other failure.
async function post(items) {
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
    if (!spent(json)) return check("sendmessage", json)
    if (i) return null
    warn(`sendmessage ret=-2 ${short(json.errmsg ?? "", 60)}, retrying in ${RETRY_MS / 1000} s`)
    await new Promise((r) => setTimeout(r, RETRY_MS))
  }
}

// --- the shared send budget (quota.js decides, the state file keeps the count and the outbox) ---
// `sent` counts the bot messages since the user's last one, over every process that sends. A send is claimed before it
// goes out, in one locked read-modify-write, so two processes never both take the last one.

// Claims `n` sends at priority `prio`. Returns the decision; for HIGH with nothing left, `entry` ({ text } or
// { file, as }) went into the outbox, and when `notice` is set the last send was taken for the notice (`k`: queue length).
function claim(prio, n, entry) {
  let d
  update((s) => {
    // Paused (see run, "pause"): nothing is pushed and nothing is queued, only replies to the user's own messages go out.
    if (s.paused && prio !== REPLY) return void (d = { act: "drop" })
    d = decide(s, prio, n)
    if (d.act === "send") s.sent = (s.sent ?? 0) + n
    else if (d.act === "queue") {
      const k = enqueue(s, entry)
      if (d.notice) ((s.noticed = true), (s.sent = (s.sent ?? 0) + 1), (d.k = k))
    }
  })
  return d
}
const refund = (n) => update((s) => (s.sent = Math.max(0, (s.sent ?? 0) - n)))
// iLink said the allowance is spent although we counted fewer: believe iLink, and keep `entry` for the next token.
const exhaust = (entry) => update((s) => (entry && !s.paused && enqueue(s, entry), (s.sent = QUOTA)))

// The one message that says the allowance is out, in the send claim() kept free.
async function notice(k) {
  try {
    if (!(await post(textItems(noticeText(k))))) exhaust()
  } catch (e) {
    warn("quota notice:", e)
    update((s) => ((s.noticed = false), (s.sent = Math.max(0, (s.sent ?? 0) - 1))))
  }
}

// A high-priority message in one send: sent, or QUEUED in the outbox when the allowance is gone. `build` makes the items
// (an upload for a file), only after the send is claimed.
async function sendHigh(entry, build = async () => textItems(entry.text), prio = HIGH) {
  const d = claim(prio, 1, entry)
  if (d.act === "drop") return PAUSED
  if (d.act === "queue") return (d.notice && (await notice(d.k)), QUEUED)
  let status
  try {
    status = await post(await build())
  } catch (e) {
    refund(1)
    throw e
  }
  if (status) return status
  exhaust(entry)
  return QUEUED
}

// A low-priority message (progress, file offer): all its chunks or none, SKIPPED when too little of the allowance is left.
async function sendLow(chunks) {
  const d = claim(LOW, chunks.length)
  if (d.act === "drop") return PAUSED
  if (d.act !== "send") return SKIPPED
  let status
  for (const [i, c] of chunks.entries()) {
    if (i) await gap()
    try {
      status = await post(textItems(c))
    } catch (e) {
      refund(chunks.length - i)
      throw e
    }
    if (!status) return (exhaust(), SKIPPED)
  }
  return chunks.length > 1 ? `${status} ×${chunks.length}` : status
}

// Sends a text (or the chunks splitText made), one chunk after another. Never throws; returns a short status string
// without secrets: "queued" when any part went to the outbox, "skipped" for a low-priority message that was dropped,
// "paused" when the bridge is paused (nothing sent, nothing queued), "error" on a failure. A failed chunk stops the
// rest, so a later chunk never arrives without it. `prio` REPLY: an answer to the user's own message, which goes out
// while paused too.
export async function send(text, prio = HIGH) {
  const chunks = Array.isArray(text) ? text : splitText(text)
  try {
    if (prio === LOW) return await sendLow(chunks)
    let status = ""
    let queued = false
    for (const [i, c] of chunks.entries()) {
      if (i && status !== QUEUED) await gap()
      status = await sendHigh({ text: c }, undefined, prio)
      if (status === PAUSED) return PAUSED
      queued ||= status === QUEUED
    }
    return queued ? QUEUED : chunks.length > 1 ? `${status} ×${chunks.length}` : status
  } catch (e) {
    warn("send:", e)
    return "error"
  }
}

// What a queued entry sends: its text, or the uploaded file or image.
async function deliver(grp, text = grp.text) {
  if (text != null) return post(textItems(text))
  const { item } = grp.as === "image" ? await uploadImage(grp.file) : await uploadFile(grp.file)
  return post([item])
}

// After the user's message brought a fresh allowance: sends the outbox in order (texts merged into as few messages as
// fit one), keeping RESERVE sends for what comes next. An entry leaves the outbox only once it is sent. Whoever receives
// the user's messages calls it; the hook processes and everything else only enqueue.
export function flushOutbox() {
  return (g.flushing ??= doFlush()
    .catch((e) => warn("outbox:", e))
    .finally(() => (g.flushing = null)))
}

async function doFlush() {
  for (;;) {
    let s = state()
    if (alive(s.outbox).length !== (s.outbox?.length ?? 0)) s = update((x) => expire(x))
    const grp = groups(alive(s.outbox), CHUNK_CHARS)[0]
    if (!grp) return void (s.lost && update((x) => delete x.lost))
    // What was dropped (too old, or the queue was full) is told once, in front of the first text.
    const lost = grp.text != null ? (s.lost ?? 0) : 0
    if (claim(FLUSH, 1).act !== "send") return
    let status
    try {
      status = await deliver(grp, lost ? md(lostNote(lost), grp.text) : grp.text)
    } catch (e) {
      refund(1)
      warn("outbox:", e)
      // Something iLink refuses or a file that is gone would block everything behind it; a network failure waits for the next time.
      if (!e.rejected && e.code !== "ENOENT") return
      status = "dropped"
    }
    if (!status) return exhaust()
    update((x) => {
      x.outbox = (x.outbox ?? []).filter((e) => !grp.ids.includes(e.id))
      if (!x.outbox.length) delete x.outbox
      if (lost && status !== "dropped") x.lost = Math.max(0, (x.lost ?? 0) - lost)
      if (!x.lost) delete x.lost
    })
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
// Throws on failure; returns the status of each step (no secrets), or "queued" when the allowance is gone (the image
// waits in the outbox and is uploaded when it is sent).
export async function sendImage(file) {
  const problem = await imageProblem(file)
  if (problem) throw new Error(`${path.basename(file)} ${problem}`)
  let steps = []
  const status = await sendHigh({ file, as: "image" }, async () => {
    const up = await uploadImage(file)
    steps = up.steps
    return [up.item]
  })
  return status === QUEUED || status === PAUSED ? status : [...steps, `sendmessage ${status}`].join(", ")
}

// null when `file` is a sendable file, else the reason.
async function fileProblem(file) {
  const st = await fs.promises.stat(file).catch(() => null)
  if (!st?.isFile()) return "文件不存在"
  if (!st.size) return "是空文件"
  return st.size > FILE_MAX_BYTES ? `太大（超过 ${FILE_MAX_BYTES / 1024 ** 2} MB）` : null
}

// Upload: getuploadurl (`mediaType` 1 image, 3 file) → POST the AES-128-ECB ciphertext to the CDN. Returns the media
// reference sendmessage needs, the plain and encrypted sizes, and the step statuses (no secrets).
async function upload(file, mediaType) {
  const { to } = recipient()
  const buf = await fs.promises.readFile(file)
  const key = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null)
  const data = Buffer.concat([cipher.update(buf), cipher.final()])
  const filekey = crypto.randomBytes(16).toString("hex")
  const r = await ilink("ilink/bot/getuploadurl", {
    filekey,
    media_type: mediaType,
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
  // A big file is worth a retry on a CDN 5xx or a dropped connection; a 4xx is final.
  let res
  for (let i = 1; ; i++) {
    try {
      res = await fetch(`${CDN}/upload?${q}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: data,
        signal: AbortSignal.timeout(60_000 + Math.ceil(data.length / 1e6) * 2000),
      })
      if (res.status < 500 || i >= 3) break
    } catch (e) {
      if (i >= 3) throw e
    }
  }
  const param = res.headers.get("x-encrypted-param")
  if (res.status !== 200 || !param)
    throw new Error(`cdn upload failed: http=${res.status} ${short(res.headers.get("x-error-message") ?? "", 120)}`)
  steps.push(`cdn http=${res.status}`)
  const media = { encrypt_query_param: param, aes_key: Buffer.from(key.toString("hex")).toString("base64"), encrypt_type: 1 }
  return { media, rawsize: buf.length, size: data.length, steps }
}

// Upload only: the image item sendmessage would carry, and the step statuses.
export async function uploadImage(file) {
  const { media, size, steps } = await upload(file, 1)
  return { item: { type: 2, image_item: { media, mid_size: size } }, steps }
}

// Upload only: the file item (type 4) sendmessage would carry, and the step statuses.
export async function uploadFile(file) {
  const { media, rawsize, steps } = await upload(file, 3)
  return { item: fileItem(media, path.basename(file), rawsize), steps }
}

// Sends any file as a file message. Throws on failure; returns the status of each step (no secrets), or "queued" like sendImage.
export async function sendFile(file) {
  const problem = await fileProblem(file)
  if (problem) throw new Error(`${path.basename(file)} ${problem}`)
  let steps = []
  const status = await sendHigh({ file, as: "file" }, async () => {
    const up = await uploadFile(file)
    steps = up.steps
    return [up.item]
  })
  return status === QUEUED || status === PAUSED ? status : [...steps, `sendmessage ${status}`].join(", ")
}

// Image paths mentioned in a reply (see mentionedPaths in files.js).
export const imagePaths = (text, baseDir) => mentionedPaths(text, baseDir, (raw) => IMG.test(raw), MAX_IMAGES)

// Local OpenCode HTTP API, for what the plugin context doesn't expose in 2.0.32 (session list/active, forms, messages).
async function oc(pathname, body, method = body ? "POST" : "GET") {
  const svc = readJson(SERVICE_FILE)
  if (!svc?.url || !svc?.password) throw Object.assign(new Error(OC_DOWN), { down: true })
  const res = await fetch(new URL(pathname, svc.url.replace("0.0.0.0", "127.0.0.1")), {
    method,
    headers: {
      Authorization: "Basic " + Buffer.from(`opencode:${svc.password}`).toString("base64"),
      ...(body && { "Content-Type": "application/json" }),
    },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  }).catch((e) => {
    // A stale service.json after OpenCode quit: connection refused, not an API error.
    if (e?.name === "TimeoutError") throw e
    throw Object.assign(new Error(OC_DOWN), { down: true })
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
export const lastReply = async (sessionID, stopAtUser = true) =>
  replyText((await oc(`/api/session/${sid(sessionID)}/message?limit=30&order=desc`)).data, stopAtUser)

// Pushes go out one at a time in call order, so a progress push in flight never lands after the push that follows it.
function push(sessionID, text, prio = HIGH) {
  update((s) => (s.last = sessionID))
  return (g.chain = (g.chain ?? Promise.resolve()).then(() => send(text, prio)))
}

// The final push of a finished turn: the text, then its images. The file offer (if the turn has files) rides in the
// last chunk of the text when it fits, and otherwise follows as a low-priority message. Returns the text's status.
// `offer`: { reply, dir, edited } as for offerFiles.
export async function pushFinal(key, text, { images = [], ...offer } = {}) {
  const o = await planOffer(key, offer)
  const chunks = splitText(text)
  const folded = o ? foldOffer(chunks, o, CHUNK_CHARS) : null
  const status = await push(key, folded ?? chunks)
  for (const f of images) await sendImage(f).catch((e) => warn("image:", e))
  if (o && !folded) await push(key, o, LOW)
  return status
}

// --- live progress: finished text segments of a running conversation, pushed at most every liveMs() ---
// One entry per conversation key (OpenCode session id or codex:<thread>) while it runs, shared by all plugin instances:
// { texts, tools, at, pushed, skipped, timer, info, child }. `info()` resolves to { head } or { child: true } at push time.
// Progress is low priority (see quota.js): near the end of the allowance a segment is dropped and counted in `skipped`.

const NO_LIVE = { body: "", pushed: false }
const PAUSE = "（微信限制机器人连着发消息，实时推送先停一下，完成时照常推送；你发任何一条消息就恢复）"

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
  // The first push waits liveMs() from the first segment, so a short run still ends with a single push.
  e.at ??= Date.now()
  e.timer ??= setTimeout(() => flushLive(key, e).catch((err) => warn("live:", err)), liveDelay(e.at, Date.now(), state().sent ?? 0))
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
  const r = { body: on || e.pushed ? liveBody(e.texts, e.tools) : "", pushed: e.pushed, ...(e.skipped && { skipped: e.skipped }) }
  Object.assign(e, { texts: [], tools: new Map() })
  if (r.body) Object.assign(e, { pushed: true, at: Date.now() })
  return r
}

async function flushLive(key, e) {
  e.timer = null
  // Off, or paused: the text waits for the final push of this run.
  if (g.progress.get(key) !== e || !liveOn(state(), key) || paused()) return
  const { head: h, child } = await e.info()
  if (child) return void Object.assign(e, { child: true, texts: [], tools: new Map() })
  if (g.progress.get(key) !== e) return
  const body = liveBody(e.texts, e.tools)
  if (!body) return
  const segments = e.texts.length
  const s = state()
  const msg = md(h, clip(body))
  const need = splitText(msg).length
  const skip = () => Object.assign(e, { skipped: (e.skipped ?? 0) + segments })
  // Too little of the allowance is left: drop it (the final push says how much), keep the sends for what matters.
  if (decide(s, LOW, need).act !== "send") return void (skip(), Object.assign(e, { texts: [], tools: new Map() }))
  takeLive(key)
  const status = await push(key, left(s) - need < RESERVE + 1 ? md(msg, PAUSE) : msg, LOW)
  if (status === SKIPPED) skip()
}

const sessionsURL = (limit, dir) =>
  `/api/session?limit=${limit}&parentID=null${dir ? `&directory=${encodeURIComponent(dir)}` : ""}`

// One line per conversation, newest first: `{ updated, line }` from OpenCode and Codex merged.
export const mergeLines = (rows, limit = 10) =>
  [...rows].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0)).slice(0, limit).map((r) => r.line)

// The 「列表」 text: one bullet per conversation.
export const listText = (rows, limit) => {
  const lines = mergeLines(rows, limit)
  return lines.length ? ul(lines) : "没有对话"
}

const codexLine = (t) => ({
  updated: t.updated,
  line: `${codexHead(numOf(CODEX + t.id), t.cwd, t, { base, short })} · ${bridge().running(t.id) ? "运行中" : "空闲"}`,
})

// `dir` is an OpenCode folder, or `codex:<folder>` for one listing only Codex threads.
async function listSessions(dir) {
  await prune()
  if (dir?.startsWith(CODEX)) {
    return listText((await codexThreads({ cwd: dir.slice(CODEX.length) })).map(codexLine), Infinity)
  }
  const [list, active, codex] = await Promise.all([
    // Without OpenCode (Codex-only daemon) the list is just the Codex threads.
    oc(sessionsURL(10, dir)).catch((e) => {
      if (!e.down || dir) throw e
      return []
    }),
    oc("/api/session/active").catch(() => ({ data: {} })),
    dir ? [] : codexThreads(),
  ])
  const rows = toArr(list)
    .filter((s) => !s.time?.archived)
    .map((s) => ({
      updated: s.time?.updated,
      line: `${head(numOf(s.id), s)} · ${active.data?.[s.id] ? "运行中" : (STATUS[s.outcome] ?? "空闲")}`,
    }))
  return listText([...rows, ...codex.map(codexLine)])
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

export const dirsText = (dirs) => (dirs.length ? md("文件夹：", numbered(dirs.map(dirLabel)), "回复「目录 编号」选择") : "没有文件夹")
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
  if (cmd.type === "quota") return quotaText(state()) + (paused() ? "（已暂停）" : "")
  if (cmd.type === "pause") return (update((s) => (s.paused = true)), pausedText(coolBridge()))
  if (cmd.type === "resume") {
    const was = paused()
    update((s) => delete s.paused)
    warmBridge()
    const k = alive(state().outbox).length
    return was ? `已恢复${k ? `，队列里 ${k} 条，接着补发` : ""}` : "没有暂停，一直在运行"
  }
  if (cmd.type === "dirs") {
    return dirsText(await listDirs())
  }
  if (cmd.type === "cd") {
    const dir = pickDir(state().dirs ?? (await listDirs()), cmd.arg) ?? pickDir(await listDirs(), cmd.arg)
    if (!dir) return `没找到「${cmd.arg}」，发「目录」查看`
    update((s) => (s.dir = dir))
    return md(`已选中 ${dirLabel(dir)}`, await listSessions(dir), "回复「编号 内容」继续旧对话，「新对话 内容」开新对话")
  }
  if (cmd.type === "new") return newSession(cmd.text)
  if (cmd.type === "image") {
    const file = toPath(cmd.path, dirPath(state().dir))
    if (!file) return /^[a-z][\w+.-]+:/i.test(cmd.path) && !/^file:/i.test(cmd.path) ? "只能发电脑上的文件" : "相对路径要先发「目录」选文件夹"
    await sendImage(file)
    return [] // the image itself is the confirmation
  }
  if (cmd.type === "file") {
    // Explicit, so the secret filter doesn't apply; the size limit does.
    const file = toPath(cmd.path, dirPath(state().dir))
    if (!file) return /^[a-z][\w+.-]+:/i.test(cmd.path) && !/^file:/i.test(cmd.path) ? "只能发电脑上的文件" : "相对路径要先发「目录」选文件夹"
    await sendFile(file)
    return []
  }
  if (cmd.type === "filehint") {
    if (cmd.on != null) update((s) => (s.filesOff = !cmd.on))
    const on = !state().filesOff
    if (cmd.on == null) return md(`文件提示：${on ? "开" : "关"}`, "「文件提示 关」/「文件提示 开」切换")
    return on ? "文件提示已打开：每轮结束后会列出这一轮的文件，由你选要不要发" : "文件提示已关闭，需要文件时发「文件 路径」"
  }
  if (cmd.type === "files") return fileOffer(cmd)
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
    return md(head(n, session), clip(await lastReply(sessionID, false), n) || "（还没有回复）")
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
  return md(`${tg} ${a.cancel ? "忽略" : "提交"}没成功：${why}`, ...(status === "pending" ? ["请重新回答：", formText(form, n)] : []))
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

// A header, a bullet list and a footer as messages under the WeChat push size: the header leads the first, the footer
// ends the last, and a split falls between two items.
export function listMessages(head, items, foot = "", max = CHUNK_CHARS) {
  const parts = items.length ? chunkLines(ul(items).split("\n"), max - Math.max(head.length, foot.length) - 2) : [""]
  parts[0] = md(head, parts[0])
  parts[parts.length - 1] = md(parts.at(-1), foot)
  return parts
}

// Model list, or a switch to models[pick]. `current` is the label of the model in use.
function modelReply(tg, models, current, arg, apply, note) {
  if (!models.length) return `${tg} 没有可用的模型`
  const footer = "回复「/model 编号」或「/model 名字」切换"
  if (!arg) return listMessages(`${tg} 可用模型（共 ${models.length} 个）：`, modelLines(models, current), footer)
  const found = pickModel(models, arg)
  if (!found.length) return `${tg} 没找到模型「${arg}」，发「/model」查看`
  if (found.length > 1) {
    const lines = modelLines(models, current).filter((_, i) => found.includes(models[i]))
    return listMessages(`${tg} 有 ${found.length} 个匹配「${arg}」，回「/model 编号」选一个：`, lines.slice(0, 30))
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
  if (!known) return md(`不认识的命令 /${cmd.name}，发「帮助」查看`, cmds.length && `OpenCode 命令：${cmds.map((c) => "/" + c).join(" ")}`)
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

// The newest turns of a Codex thread, newest first. From the history db the desktop keeps (read-only, no app-server, so
// no 3 to 9 s start) when it has caught up with the thread's rollout file; from app-server when it hasn't, can't be
// read, or our own turn is running in the thread (app-server has what the db has not been given yet).
export async function codexTurns(threadId, limit) {
  if (!bridge().running(threadId)) {
    const turns = await codexMod.codexHistory?.(threadId, limit)
    if (turns) return turns
  }
  return bridge().turns(threadId, limit)
}

async function runCodex(cmd, threadId, n, tg) {
  const head = async () => codexHead(n, "", await codexThread(threadId), { base, short })
  if (cmd.type === "show") {
    const reply = replyText(codexMsgs(await codexTurns(threadId, 3)), false)
    return md(await head(), clip(reply, n) || "（还没有回复）")
  }
  if (cmd.type === "history") return historyLines(codexMsgs(await codexTurns(threadId, cmd.count + 2)), n, cmd.count, tg)
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
  if (kind === "done") return md(head, clip(text, n) || "完成（没有文字回复）")
  if (kind === "failed") return md(head, `出错：${short(text, 300)}`)
  if (kind === "approval") return md(head, `等你批准：${short(text, 300)}`, `回复「${n} y」批准，「${n} n」拒绝（这个对话在后台运行，只能在微信里批准）`)
  return md(head, text)
}

// Called synchronously in the order the app-server reports, so progress bookkeeping keeps that order.
function codexPush(threadId, kind, text, extra) {
  const key = CODEX + threadId
  const info = async () => {
    const thread = await codexThread(threadId)
    remember(key, cleanDir(thread?.cwd))
    return { head: codexHead(await assign(key), "", thread, { base, short }) }
  }
  if (kind === "text") return addText(key, text, info)
  if (kind === "tool") return addTool(key, text, info)
  const live = takeLive(key, kind !== "approval" && kind !== "question", liveOn(state(), key))
  if (kind !== "end") return codexSend(threadId, kind, text, live, extra).catch((e) => warn("codex push:", e))
}

// `extra`: { fileChanges } of a finished turn, from codex.js (only when the turn changed files).
async function codexSend(threadId, kind, text, live, extra) {
  const key = CODEX + threadId
  const n = await assign(key)
  const thread = await codexThread(threadId)
  remember(key, cleanDir(thread?.cwd))
  if (kind === "question") text = formText(questionForm(text), n, false)
  const h = codexHead(n, "", thread, { base, short })
  let msg = kind === "done" ? doneText(h, n, text, live, tagIn(state(), key, n)) : withPre(codexPushText(h, n, kind, text), live)
  if (kind === "failed") msg = withSkip(msg, live, n)
  const { files, big } = kind === "done" ? await replyImages(text, cleanDir(thread?.cwd)) : { files: [], big: [] }
  if (big.length) msg = md(msg, `（图片太大没发：${big.join("、")}）`)
  if (kind === "done") await pushFinal(key, msg, { images: files, reply: text, dir: cleanDir(thread?.cwd), edited: fileChangePaths(extra?.fileChanges) })
  else await push(key, msg)
}

// One app-server bridge per process; a hot-reloaded module stops the old one (it would still run old code).
function bridge() {
  if (g.bridge?.gen !== GEN) {
    g.bridge?.stop()
    g.bridge = createBridge({
      markerDir: PENDING_DIR,
      push: codexPush,
      log: warn,
      // WECHAT_NOTIFY_CODEX_CMD: a test seam, the app-server command as a JSON array, like ["node", "fake-app-server.js"].
      ...(process.env.WECHAT_NOTIFY_CODEX_CMD && { bin: () => JSON.parse(process.env.WECHAT_NOTIFY_CODEX_CMD) }),
    })
    g.bridge.gen = GEN
  }
  return g.bridge
}

// The process that polls WeChat keeps the Codex app-server up while the bridge isn't paused, so the first message to a
// Codex thread doesn't wait for it to start (3 to 9 s here). Any other process starts it on demand and lets it idle out.
// `?.` below: a hot reload may keep an older codex.js, which has no warm().
function warmBridge() {
  if (!g.poller || paused()) return
  g.warmed = true
  bridge().warm?.(true)
}

// Back to on demand (paused, or the poll lock is lost): "closed" when a running server is stopped, "later" when a reply of
// ours is still running and the server stops after it, else "".
function coolBridge() {
  if (!g.warmed) return ""
  g.warmed = false
  const b = g.bridge
  const up = b?.up?.()
  return b?.warm?.(false) ? "later" : up ? "closed" : ""
}

// OpenCode: files the finished turn of `sessionID` wrote or changed, from its tool calls and (where OpenCode keeps
// snapshots, i.e. a git repo) the session diff, which also sees files a shell command wrote.
export async function turnEdited(sessionID, dir) {
  const msgs = (await oc(`/api/session/${sid(sessionID)}/message?limit=100&order=desc`)).data
  const diff = await oc(`/api/session/${sid(sessionID)}/diff`).then(toArr, () => [])
  return [...toolPaths(msgs, dir), ...diffPaths(diff, dir)]
}

// After a finished turn: the offer text for the files it mentioned (`reply`) or changed (`edited`: paths, or a function
// returning them, only called when offers are on); "" when there is nothing to offer. It keeps the offer in the state
// file until a newer one, 24 hours or the conversation's number is gone.
async function planOffer(key, { reply, dir, edited = [] }) {
  try {
    if (state().filesOff) return ""
    const { files, more } = candidates({ reply, dir, edited: typeof edited === "function" ? await edited() : edited, bridgeDirs: [DIR, path.join(os.homedir(), ".cli-bridge")] })
    if (!files.length) return ""
    const t = await tag(key, dir)
    update((s) => ((s.offers ??= {})[key] = { files: files.map((f) => f.path), at: Date.now() }))
    return offerText(t, files, more, numOf(key), dir)
  } catch (e) {
    warn("file offer:", e)
    return ""
  }
}

// The offer as a message of its own (low priority: dropped when the allowance is nearly used, the offer stays in
// the state file for 「N 文件」). pushFinal puts it into the final reply instead.
export async function offerFiles(key, opts) {
  const o = await planOffer(key, opts)
  if (o) await push(key, o, LOW)
}

// 「3 文件」 lists the saved offer of a conversation, 「3 文件 1 3」 / 「3 文件 全部」 sends from it. Without the number
// it is the current target conversation.
async function fileOffer(cmd) {
  const key = cmd.n == null ? targetID() : sessionOf(cmd.n)
  if (!key) return cmd.n == null ? "先发「列表」选一个对话" : noNum(cmd.n)
  const n = numOf(key)
  const tg = await tag(key)
  const offer = liveOffer(state().offers?.[key])
  if (!offer) return `${tg} 没有可选的文件（每轮结束后才会列出，24 小时内有效）；要发电脑上的文件，发「文件 路径」`
  if (!cmd.sel) {
    const files = offer.files.map((p) => ({ path: p, size: fs.statSync(p, { throwIfNoEntry: false })?.size ?? null }))
    return offerText(tg, files, 0, n, state().info?.[key]?.dir)
  }
  const { idx, bad } = resolveSelection(cmd.sel, offer.files.length)
  if (bad.length) return `${tg} 没有第 ${bad.join("、")} 个文件（共 ${offer.files.length} 个），发「${n} 文件」看列表`
  let sent = 0
  let queued = 0
  const failed = []
  for (const [i, k] of idx.entries()) {
    const f = offer.files[k]
    if (i) await new Promise((r) => setTimeout(r, 300))
    try {
      const problem = await fileProblem(f)
      if (problem) failed.push(`${path.basename(f)}（${problem}）`)
      else if ((await sendFile(f)) === QUEUED) queued++
      else sent++
    } catch (e) {
      warn("file:", e)
      failed.push(`${path.basename(f)}（${short(e?.message, 80)}）`)
    }
  }
  return md(sent && `已发送 ${sent} 个文件`, queued && `${queued} 个文件排队了（额度用完），你再发任何一句话就补发`, failed.length && `没发出去：${failed.join("、")}`)
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

// Runs the jobs of WeChat messages side by side, but in order where order matters. `submit(plan)` is called once per
// message, in arrival order, and `plan()` runs when every global job before it has finished; it returns null (nothing to
// do) or { lane, run }. Jobs of one lane (a conversation, or "·quick") run one after another, lanes run concurrently.
// Lane null is a global job: it first waits for every job started so far (at most waitMs, so one stuck job can't make
// the bridge deaf), runs alone, and the next message is planned only after it. Resolves when the job has run.
export function scheduler(waitMs = 30_000) {
  let routing = Promise.resolve()
  const tails = new Map()
  const live = new Set()
  const submit = (plan) =>
    new Promise((resolve, reject) => {
      routing = routing.then(async () => {
        let job
        try {
          job = plan()
        } catch (e) {
          return reject(e)
        }
        if (!job) return resolve()
        const { lane, run: fn } = job
        if (lane == null) {
          await new Promise((go) => {
            const t = setTimeout(go, waitMs)
            Promise.all([...live]).then(() => (clearTimeout(t), go()))
          })
        }
        const p = (lane == null ? Promise.resolve() : (tails.get(lane) ?? Promise.resolve())).then(fn)
        const end = p.then(() => {}, () => {})
        live.add(end)
        if (lane != null) tails.set(lane, end)
        end.then(() => (live.delete(end), tails.get(lane) === end && tails.delete(lane)))
        p.then(resolve, reject)
        if (lane == null) await end
      })
    })
  return { submit }
}
const sched = (g.sched ??= scheduler())

// 帮助 / 列表 / 额度 have a lane of their own, so they answer at once whatever a conversation is busy with.
const QUICK = new Set(["help", "list", "quota"])
const MISC = new Set(["image", "file", "filehint", "live"])

// Lane of a message's command (see scheduler): null for the ones that change what comes after them (pause, resume,
// 新对话 which becomes the target, anything with media, and text while buffered media waits for it). Picking the lane
// also makes a numbered message the target, so the unnumbered ones behind it follow it even before it has run.
export function laneOf(cmd, hasMedia = false) {
  if (hasMedia || !cmd || ["pause", "resume", "new"].includes(cmd.type)) return null
  if (cmd.type === "multi") return cmd.cmds.every((c) => QUICK.has(c.type)) ? "·quick" : "·dir"
  if (QUICK.has(cmd.type) || (cmd.type === "text" && !cmd.text)) return "·quick"
  if (cmd.type === "dirs" || cmd.type === "cd") return "·dir"
  if (MISC.has(cmd.type)) return "·misc"
  if ((cmd.type === "text" || cmd.type === "slash") && liveMedia(g.media).length) return null
  const key = cmd.n == null ? targetID() : sessionOf(cmd.n)
  if (!key) return "·misc"
  if (cmd.n != null && state().target !== key) update((s) => (s.target = key))
  return key
}

// Handles one polled message. `out` sends each reply (exported with it so a check can run without WeChat). Returns when
// the message has been handled; the caller needn't wait for that before it passes the next message.
export async function inbound(msg, floor, out = (t) => send(t, REPLY)) {
  const account = readJson(path.join(DIR, "account.json"))
  const text = inboundText(msg, account?.userId)
  const media = inboundMedia(msg, account?.userId)
  if (text == null && !media.length) return
  // A message from the user brings a fresh context_token, and with it a fresh allowance of bot messages.
  if (msg.context_token && (msg.context_token !== state().contextToken || state().sent || state().noticed)) {
    update((s) => ((s.contextToken = msg.context_token), (s.sent = 0), delete s.noticed))
  }
  // Drop backlog: without a saved cursor the first poll can return old messages, and stale commands are risky.
  const created = Number(msg.create_time_ms ?? 0)
  if (created && created < floor()) return
  const key = msg.message_id ?? `${msg.client_id}:${created}`
  if (g.handled.has(key)) return
  g.handled.add(key)
  if (g.handled.size > 200) g.handled.delete(g.handled.values().next().value)
  const parsed = text == null ? null : parseCommand(text)
  return sched.submit(() => {
    // Planned after every earlier global job (a 「/stop」 before this message has taken effect by now).
    let cmd = parsed
    const wasPaused = paused()
    // 「开始」 is a command only while paused; otherwise it is a message for the agent like any other.
    if (cmd?.soft && !wasPaused) cmd = { type: "text", text: text.trim() }
    // Paused: only /start, 帮助 and 额度 are heard. Nothing else runs, and media is not even saved.
    if (wasPaused && !heardWhilePaused(cmd)) return null
    return { lane: laneOf(cmd, media.length > 0), run: () => handle(cmd, text, media, wasPaused, out) }
  })
}

async function handle(cmd, text, media, wasPaused, out) {
  // What could not be sent while the allowance was out goes first, before this message's own reply.
  await flushOutbox()
  // A photo and its caption arrive as separate messages: media waits in g.media for the next text.
  const ack = media.length ? await bufferMedia(media) : ""
  const reply = text == null ? ack : await run(cmd).catch((e) => `出错了：${short(e?.message, 150)}`)
  // run() returns a string, or an array: replies that fit one message are sent as one (each message costs one of the
  // ~10 sends), the rest one at a time, spaced out so WeChat doesn't throttle.
  for (const [i, r] of mergeTexts([reply].flat().filter(Boolean), CHUNK_CHARS).entries()) {
    if (i) await new Promise((resolve) => setTimeout(resolve, 300))
    await out(r)
  }
  // 「/start」: what queued up before the pause goes out now, after the 「已恢复」.
  if (wasPaused && !paused()) await flushOutbox()
}

// Removes its abort listener when the timer fires; otherwise every sleep leaves one on the long-lived poller signal.
export const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const done = () => (clearTimeout(t), signal.removeEventListener("abort", done), resolve())
    const t = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })

// Wait after the `fails`-th failed poll in a row: 2 s, 4 s, ... up to 30 s. The cap is short on purpose: after a sleep or a
// network change the first polls fail, and a longer wait would leave the phone unanswered for minutes.
export const pollDelay = (fails) => Math.min(30_000, 2000 * 2 ** fails)

// Calls onWake(ms since the last tick) when a timer of this process fires much later than due, which means the machine
// slept: a 30 s interval that comes more than 2 minutes after the one before. `now` is injectable.
export function wakeWatch(onWake, { now = Date.now, every = 30_000, gap = 120_000 } = {}) {
  let last = now()
  const tick = () => {
    const t = now()
    const slept = t - last
    last = t
    if (slept > gap) onWake(slept)
  }
  const timer = setInterval(tick, every)
  timer.unref?.()
  return Object.assign(() => clearInterval(timer), { tick })
}

// `ctl.kick()`: abort the poll in flight (or the wait after a failed one) and poll again at once, with the failures forgotten.
// `delay`: the wait after a failure, pollDelay unless a test says otherwise.
export async function poll(signal, ctl = {}, delay = pollDelay) {
  const startedAt = Date.now()
  const floor = state().buf ? () => Date.now() - 10 * 60_000 : () => startedAt
  let fails = 0
  let kicked = new AbortController()
  ctl.kick = () => {
    fails = 0
    kicked.abort()
  }
  while (!signal.aborted) {
    kicked = new AbortController()
    const here = AbortSignal.any([signal, kicked.signal])
    const t0 = Date.now()
    try {
      const r = await ilink("ilink/bot/getupdates", { get_updates_buf: state().buf ?? "" }, AbortSignal.any([here, AbortSignal.timeout(45_000)]))
      if (Number(r.errcode) === -14) {
        update((s) => (s.buf = ""))
      }
      if (!r.ok || Number(r.ret ?? 0) !== 0 || Number(r.errcode ?? 0) !== 0)
        throw new Error(`getupdates http=${r.http} ret=${r.ret} errcode=${r.errcode} ${short(r.errmsg ?? "", 100)}`)
      if (r.get_updates_buf && r.get_updates_buf !== state().buf) {
        update((s) => (s.buf = r.get_updates_buf))
      }
      // Not awaited: a slow message must not hold up the ones behind it (inbound keeps each conversation in order).
      for (const m of r.msgs ?? []) inbound(m, floor).catch((e) => warn("inbound:", e))
      fails = 0
      // A long poll that returns at once (proxy, outage, a cursor that never advances) would otherwise spin.
      if (Date.now() - t0 < 1000) await sleep(1000, here)
    } catch (e) {
      if (signal.aborted) break
      if (kicked.signal.aborted || e?.name === "TimeoutError" || e?.name === "AbortError") continue
      warn("poll:", e)
      await sleep(delay(fails++), here)
    }
  }
}

// WECHAT_NOTIFY_POLL: "0" never polls, "1" is eligible in any process, otherwise only the `--service` process is.
// Eligible is not enough: only the process that holds DIR/poll.lock polls (see poll-lock.js).
const POLL_ENV = process.env.WECHAT_NOTIFY_POLL
const POLLS = POLL_ENV === "1" || (POLL_ENV !== "0" && process.argv.includes("--service"))

function abortPoller() {
  g.poller?.abort()
  g.poller = null
  g.wake?.()
  g.wake = null
}

// Not polling any more (the lock is lost, or we quit): the Codex app-server goes back to on demand.
function stopPoller() {
  abortPoller()
  coolBridge()
}

// wakeWatch options, for a test to inject a clock (see runDaemon).
let wakeOpts = {}

// The machine woke from sleep: renew the lock beat at once (so nobody takes the lock for its old beat), poll again at
// once instead of waiting for the dead connection, and bring the Codex app-server back if it is gone.
function onWake(slept) {
  warn(`wake: the computer was asleep for about ${Math.round(slept / 1000)} s; renewing the lock, polling again`)
  g.lock?.wake?.()
  g.poller?.kick?.()
  g.bridge?.revive?.()
}

function startPoller() {
  update((s) => (s.pollerPid = process.pid))
  abortPoller()
  const c = new AbortController()
  c.gen = GEN
  g.poller = c
  g.wake = wakeWatch(onWake, wakeOpts)
  poll(c.signal, c).catch((e) => warn("poller stopped:", e))
  warmBridge()
}

function stopLock(keep) {
  g.lock?.stop(keep)
  g.lock = null
}

// Standalone mode (daemon.js): the same WeChat poller and commands without OpenCode, so Codex-only users can reply too.
// OpenCode conversations still work through its HTTP API whenever an OpenCode service runs; Codex pushes come from
// codex-hook.js. The poll lock decides between this and an OpenCode plugin that may run at the same time.
// `lock` and `wake`: options of pollLock and wakeWatch, for a test to speed up the timers or inject a clock.
export function runDaemon({ log = (m) => console.log(`${new Date().toLocaleString()} ${m}`), lock = {}, wake = {} } = {}) {
  wakeOpts = wake
  const keepAlive = setInterval(() => {}, 60_000) // the lock's timers are unref'd
  // For `setup --uninstall-daemon` to find and stop us.
  const pidFile = path.join(DIR, "daemon.pid")
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(pidFile, String(process.pid))
  process.on("exit", () => {
    try {
      if (fs.readFileSync(pidFile, "utf8") === String(process.pid)) fs.rmSync(pidFile)
    } catch {}
  })
  // quit(false) stops everything without ending the process (a test); a signal ends it.
  const quit = (exit) => {
    clearInterval(keepAlive)
    process.removeListener("SIGINT", quit)
    process.removeListener("SIGTERM", quit)
    stopLock()
    stopPoller()
    g.bridge?.stop()
    g.bridge = null
    if (exit !== false) process.exit(0)
  }
  // Ours before the lock starts, so it doesn't install its own signal handlers.
  process.once("SIGINT", quit)
  process.once("SIGTERM", quit)
  stopLock(true)
  stopPoller()
  g.lock = pollLock(DIR, {
    ...lock,
    onHeld: () => (log("polling WeChat"), startPoller()),
    onLost: () => (log("another process took over WeChat polling; standing by"), stopPoller()),
  })
  g.lock.gen = GEN
  g.lock.start()
  if (!g.lock.held()) log(`another process polls WeChat (pid ${readLock(DIR)?.pid}); standing by, retrying every 30 s`)
  return quit
}

export default {
  id: "wechat-notify",
  setup(ctx) {
    const controller = new AbortController()
    g.ctxs.add(ctx)
    // Other `opencode serve` processes (TUI etc.) load this plugin too; only the desktop service polls WeChat.
    // One poller per process; a hot-reloaded module replaces the old one.
    // A reloaded (or newly evaluated) module replaces the old lock and poller; the file stays, and this pid takes it again.
    if (!POLLS) (stopLock(), stopPoller())
    else if (g.lock?.gen !== GEN) {
      stopLock(true)
      stopPoller()
      g.lock = pollLock(DIR, { onHeld: startPoller, onLost: stopPoller })
      g.lock.gen = GEN
      g.lock.start()
    }
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
      const dir = session?.location?.directory ?? event.location?.directory
      const { files, big } = await replyImages(reply, dir)
      if (big.length) text = md(text, `（图片太大没发：${big.join("、")}）`)
      if (event.type === "session.execution.succeeded") await pushFinal(sessionID, text, { images: files, reply, dir, edited: () => turnEdited(sessionID, dir) })
      else await push(sessionID, text)
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
        stopLock()
        stopPoller()
        g.bridge?.stop()
        g.bridge = null
      }
    }
  },
}
