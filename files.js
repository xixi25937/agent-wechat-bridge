// Files you can ask for after a turn: finding them (paths in a reply, files the agent changed), keeping likely secrets
// out, the offer message, and the arguments of 「N 文件 1 3」. Pure helpers plus fs.stat; index.js does the WeChat side.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { md, ul } from "./md.js"

export const IMG = /\.(png|jpe?g|gif|webp)$/i
// iLink's file limit isn't documented; cli-chat-bridge's default for files is 50 MB, so this is too.
export const FILE_MAX_BYTES = 50 * 1024 * 1024
export const OFFER_MAX = 10
export const OFFER_TTL = 24 * 60 * 60_000

// Absolute path for a path or file:/// URL as written; null for other URLs, or a relative path without a base.
export function toPath(p, baseDir) {
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

// Paths mentioned in a reply that `ok(raw)` accepts: `code spans`, markdown link targets, and bare words. Paths with
// spaces need backticks or a markdown link.
export function mentionedPaths(text, baseDir, ok, max) {
  const out = new Set()
  const re = /`([^`\n]+)`|\]\(\s*<?([^)>\n]+?)>?\s*\)|([^\s`"'<>|*?()[\]，。；：！？、「」（）]+)/g
  for (const m of String(text ?? "").matchAll(re)) {
    let raw = (m[1] ?? m[2] ?? m[3]).trim().replace(/[.,;:!]+$/, "")
    // "截图在C:\x.png": text glued before a drive letter or file: URL.
    raw = raw.slice(Math.max(0, raw.search(/(?<![a-z])([a-z]:[\\/]|file:)/i)))
    const p = ok(raw) && toPath(raw, baseDir)
    if (p) out.add(p)
    if (out.size >= max) break
  }
  return [...out]
}

const HAS_EXT = /\.[a-z0-9]{1,10}$/i

// Names that probably hold credentials, and folders that never get offered. Matched without regard to case.
const SECRET_NAME = /^(\.env|\.netrc|\.npmrc|auth\.json$|account\.json$|id_(rsa|dsa|ecdsa|ed25519)|.*\.(pem|key|pfx|p12)$)/i
const SECRET_DIR = new Set([".git", "node_modules", ".ssh"])

// `bridgeDirs`: state folders of this bridge (~/.cli-bridge, WECHAT_NOTIFY_DIR); anything under them is a secret.
export function isSecret(file, bridgeDirs = [path.join(os.homedir(), ".cli-bridge")]) {
  const parts = path.resolve(file).split(/[\\/]/)
  if (SECRET_NAME.test(parts.at(-1))) return true
  if (parts.slice(0, -1).some((s) => SECRET_DIR.has(s.toLowerCase()))) return true
  return bridgeDirs.some((d) => {
    const r = path.relative(d, file)
    return r !== "" && !r.startsWith("..") && !path.isAbsolute(r)
  })
}

// --- what a turn changed ---

// OpenCode: absolute paths the turn's edit / write / patch tools touched. `msgs` is newest first (as the API gives it);
// the turn ends at the newest user message. Failed tool calls are skipped.
export function toolPaths(msgs, dir) {
  const turn = []
  for (const m of msgs ?? []) {
    if (m.type === "user" || m.type === "compaction") break
    if (m.type === "assistant") turn.unshift(m)
  }
  const out = []
  for (const m of turn)
    for (const c of m.content ?? []) {
      if (c.type !== "tool" || c.state?.status !== "completed" || !/write|edit|patch/i.test(c.name)) continue
      const input = c.state.input ?? {}
      for (const f of [input.path, input.filePath, input.file_path]) if (typeof f === "string" && f) out.push(f)
      // apply_patch carries its files inside the patch text.
      if (/patch/i.test(c.name))
        for (const v of Object.values(input))
          if (typeof v === "string") for (const x of v.matchAll(/^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm)) out.push(x[1].trim())
    }
  return out.map((f) => (dir ? path.resolve(dir, f) : f))
}

// OpenCode's session diff (turn of the newest user message): changed files, relative to the session folder. Only works
// where OpenCode keeps snapshots (a git repo), but then it also sees files a shell command wrote.
export const diffPaths = (diff, dir) =>
  (diff ?? []).filter((d) => d?.file && d.status !== "deleted").map((d) => (dir ? path.resolve(dir, d.file) : d.file))

const noPrefix = (p) => String(p ?? "").replace(/^\\\\\?\\/, "")

// Codex: paths of the completed fileChange items (the shape of app-server items and of thread_items.item_json).
// A deleted file has nothing to send; a moved one is at its new path.
export function fileChangePaths(items) {
  return (items ?? []).flatMap((i) =>
    i?.type !== "fileChange" || i.status !== "completed"
      ? []
      : (i.changes ?? []).filter((c) => c.path && c.kind?.type !== "delete").map((c) => noPrefix(c.kind?.move_path || c.path)),
  )
}

const HISTORY = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "thread_history_1.sqlite")
const CHANGES =
  "select json_extract(j.value, '$.path') as path, json_extract(j.value, '$.kind.type') as kind, json_extract(j.value, '$.kind.move_path') as moved" +
  " from thread_items t, json_each(t.item_json, '$.changes') j where t.thread_id = ? and t.item_type = 'fileChange'" +
  " and json_extract(t.item_json, '$.status') = 'completed' and "
const BY_TURN = `${CHANGES}t.turn_id = ? order by t.rollout_ordinal, j.key`
const SINCE_USER = `${CHANGES}t.rollout_ordinal > coalesce((select max(rollout_ordinal) from thread_items where thread_id = ? and item_type = 'userMessage'), -1) order by t.rollout_ordinal, j.key`

// Codex: files the turn `turnId` of a thread changed, from the history db. Without a turn id, or when the db has no
// rows of that turn, the turn is everything after the thread's newest user message. [] when the db can't be read.
export async function codexEdited(threadId, turnId, db = HISTORY) {
  try {
    const { DatabaseSync } = await import("node:sqlite")
    const conn = new DatabaseSync(db, { readOnly: true })
    try {
      const known = turnId && conn.prepare("select 1 from thread_items where thread_id = ? and turn_id = ? limit 1").get(threadId, turnId)
      const rows = known ? conn.prepare(BY_TURN).all(threadId, turnId) : conn.prepare(SINCE_USER).all(threadId, threadId)
      return rows.filter((r) => r.kind !== "delete").map((r) => noPrefix(r.moved || r.path))
    } finally {
      conn.close()
    }
  } catch {
    return []
  }
}

// --- the offer ---

const same = (p) => (process.platform === "win32" ? p.toLowerCase() : p)

// Files to offer: paths mentioned in `reply` first, then `edited`. Existing non-empty regular files within the size
// limit, not images (those are sent on their own), not likely secrets, once each. `files` holds at most `max`
// ({ path, size }); `more` counts the rest.
export function candidates({ reply, dir, edited = [], bridgeDirs, max = OFFER_MAX, limit = FILE_MAX_BYTES } = {}) {
  const seen = new Set()
  const files = []
  let more = 0
  for (const raw of [...mentionedPaths(reply, dir, (r) => HAS_EXT.test(r), 40), ...edited]) {
    const p = dir ? path.resolve(dir, raw) : path.isAbsolute(raw) ? path.resolve(raw) : null
    if (!p || seen.has(same(p))) continue
    seen.add(same(p))
    if (IMG.test(p) || isSecret(p, bridgeDirs)) continue
    let st
    try {
      st = fs.statSync(p)
    } catch {
      continue
    }
    if (!st.isFile() || !st.size || st.size > limit) continue
    if (files.length < max) files.push({ path: p, size: st.size })
    else more++
  }
  return { files, more }
}

export function humanSize(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 ** 2).toFixed(1)} MB`
}

// File names for the list: the name alone, or the path relative to the conversation's folder when two names collide.
export function displayNames(files, dir) {
  const slash = (s) => s.replace(/\\/g, "/")
  const count = new Map()
  for (const f of files) count.set(path.basename(f).toLowerCase(), (count.get(path.basename(f).toLowerCase()) ?? 0) + 1)
  return files.map((f) => {
    if (count.get(path.basename(f).toLowerCase()) < 2) return path.basename(f)
    const r = dir ? path.relative(dir, f) : ""
    return slash(r && !r.startsWith("..") && !path.isAbsolute(r) ? r : f)
  })
}

// The offer message. `tag`: "[3] Codex · proj". `files`: { path, size } (size null: the file is gone).
export function offerText(tag, files, more, n, dir) {
  const names = displayNames(files.map((f) => f.path), dir)
  const items = files.map((f, i) => `${i + 1} ${names[i]}（${f.size == null ? "已不存在" : humanSize(f.size)}）`)
  if (more) items.push(`…还有 ${more} 个`)
  return md(`${tag} 这一轮的文件：`, ul(items), `回复「${n} 文件 1 3」发送选中的，「${n} 文件 全部」全发，不回复就不发`)
}

// The saved offer if it is still fresh, else undefined.
export const liveOffer = (offer, now = Date.now()) => (offer?.files?.length && now - offer.at < OFFER_TTL ? offer : undefined)

// --- 「N 文件 …」 arguments ---

// "1 3", "1,3", "1，3", "1、3" or 全部 / all: { all: true } or { nums: [1, 3] }; null for anything else.
export function parseSelection(arg) {
  const a = String(arg ?? "").trim()
  if (/^(全部|全发|all)$/i.test(a)) return { all: true }
  if (/^\d{1,3}(?:\s*[\s,，、]\s*\d{1,3})*$/.test(a)) return { nums: [...new Set(a.match(/\d+/g).map(Number))] }
  return null
}

// Indexes (0-based) into an offer of `count` files, and the numbers that don't exist.
export function resolveSelection(sel, count) {
  if (sel.all) return { idx: [...Array(count).keys()], bad: [] }
  const bad = sel.nums.filter((n) => n < 1 || n > count)
  return { idx: sel.nums.filter((n) => !bad.includes(n)).map((n) => n - 1), bad }
}

// --- the iLink file message ---

// What sendmessage carries for an uploaded file (item type 4). `media` is { encrypt_query_param, aes_key, encrypt_type }.
export const fileItem = (media, name, rawsize) => ({ type: 4, file_item: { file_name: name, len: String(rawsize), media } })
