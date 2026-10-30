// The send budget every sending process shares (the OpenCode plugin, the daemon, the Codex hooks), the outbox for what
// didn't fit, and the small text helpers around them. Pure: a state object in, a decision out; index.js does the I/O.
import crypto from "node:crypto"
import { md } from "./md.js"

// iLink lets a bot send about this many messages per message from the user (one context_token), then answers
// ret=-2 "prepare failed" until the user sends anything. Third-party reports (weilink v0.4.0) and our own logs, not
// documented.
export const QUOTA = 10
// Approvals, questions, errors, final replies and command replies may use everything but the last send, which belongs
// to the "额度用完了" notice. Live progress, file offers and an outbox flush leave RESERVE sends for those.
export const RESERVE = 3
export const OUTBOX_MAX = 20
export const OUTBOX_TTL = 24 * 60 * 60_000
export const HIGH = "high"
export const LOW = "low"
export const FLUSH = "flush"
// A reply to the user's own message: HIGH, and the only kind that still goes out while the bridge is paused.
export const REPLY = "reply"

export const left = (s) => Math.max(0, QUOTA - (s.sent ?? 0))

// What to do with a message of `n` sends (state `s`, priority `prio`):
//   { act: "send" }              go ahead, the caller takes the sends
//   { act: "queue", notice }     HIGH, budget gone: keep it in the outbox; `notice`: the last send is free, tell the user
//   { act: "skip" } / "stop"     LOW is dropped / an outbox flush ends, both for now
// Anything but LOW and FLUSH (HIGH, REPLY) is decided as HIGH.
export function decide(s, prio, n = 1) {
  const l = left(s)
  if (prio === LOW) return { act: l >= RESERVE + n ? "send" : "skip" }
  if (prio === FLUSH) return { act: l >= RESERVE + 1 ? "send" : "stop" }
  if (l >= 2 || (l === 1 && s.noticed)) return { act: "send" }
  return { act: "queue", notice: l === 1 }
}

// Seconds-apart progress pushes: quick while most of the allowance is left, slow once half is used.
export const liveMs = (sent = 0) => (sent >= QUOTA / 2 ? 60_000 : 15_000)

// --- outbox: s.outbox = [{ id, at, text } | { id, at, file, as: "image" | "file" }], oldest first ---

export const alive = (outbox, now = Date.now()) => (outbox ?? []).filter((e) => now - e.at < OUTBOX_TTL)

// Drops the expired entries (counted in s.lost, so the next flush can say so). Returns the rest.
export function expire(s, now = Date.now()) {
  const keep = alive(s.outbox, now)
  const gone = (s.outbox?.length ?? 0) - keep.length
  if (gone) s.lost = (s.lost ?? 0) + gone
  if (keep.length) s.outbox = keep
  else delete s.outbox
  return keep
}

// Appends `entry` ({ text } or { file, as }); past OUTBOX_MAX the oldest goes (counted in s.lost). Returns the length.
export function enqueue(s, entry, now = Date.now()) {
  const keep = expire(s, now)
  keep.push({ id: crypto.randomBytes(4).toString("hex"), at: now, ...entry })
  while (keep.length > OUTBOX_MAX) (keep.shift(), (s.lost = (s.lost ?? 0) + 1))
  s.outbox = keep
  return keep.length
}

// Texts that fit in one message of `size` join into one (a paragraph apart, so the Markdown layout stays).
export function mergeTexts(list, size) {
  const out = []
  for (const t of list) out.length && out.at(-1).length + 2 + t.length <= size ? (out[out.length - 1] = md(out.at(-1), t)) : out.push(t)
  return out
}

// The sends a flush makes: consecutive text entries merged up to `size`, each file or image alone. `ids`: the entries a
// group stands for.
export function groups(items, size) {
  const out = []
  for (const e of items) {
    const g = out.at(-1)
    if (e.text != null && g?.text != null && g.text.length + 2 + e.text.length <= size) (g.text = md(g.text, e.text), g.ids.push(e.id))
    else out.push(e.text != null ? { ids: [e.id], text: e.text } : { ids: [e.id], file: e.file, as: e.as })
  }
  return out
}

// The file offer in the last chunk of `chunks` instead of a message of its own; null when that would pass `size`.
export function foldOffer(chunks, offer, size) {
  const last = md(chunks.at(-1), offer)
  return last.length <= size ? [...chunks.slice(0, -1), last] : null
}

// --- texts ---

export const noticeText = (k) => `额度用完了：还有 ${k} 条没发，回任意一句话就补发`
export const quotaText = (s, now = Date.now()) => `已用 ${Math.min(QUOTA, s.sent ?? 0)}/${QUOTA}，队列里 ${alive(s.outbox, now).length} 条`
export const skipNote = (k, n) => `（有 ${k} 段进度没推，看桌面端或「${n} 历史」）`
export const lostNote = (k) => `（另有 ${k} 条超过 24 小时或排队太多，没能补发）`
