import assert from "node:assert/strict"
import { test } from "node:test"
import {
  FLUSH, HIGH, LOW, OUTBOX_MAX, OUTBOX_TTL, QUOTA, REPLY, RESERVE, alive, decide, enqueue, expire, foldOffer, groups, left, liveMs, mergeTexts, noticeText, quotaText,
  skipNote,
} from "./quota.js"

const at = (sent, extra) => ({ sent, ...extra })
const act = (sent, prio, n, extra) => decide(at(sent, extra), prio, n).act

test("budget: 10 sends, the last 3 are for approvals, errors, final and command replies", () => {
  assert.equal(QUOTA, 10)
  assert.equal(RESERVE, 3)
  assert.equal(left({}), 10)
  assert.equal(left({ sent: 4 }), 6)
  assert.equal(left({ sent: 14 }), 0, "never negative")
  // Low priority (progress, file offers): fine while 4 or more are left, skipped below that.
  for (const sent of [0, 3, 6]) assert.equal(act(sent, LOW), "send", `sent ${sent}`)
  for (const sent of [7, 8, 9, 10]) assert.equal(act(sent, LOW), "skip", `sent ${sent}`)
  // A low message of 2 chunks must leave the reserve too: needs 5 left.
  assert.equal(act(5, LOW, 2), "send")
  assert.equal(act(6, LOW, 2), "skip")
  // High priority goes on to the last-but-one send.
  for (const sent of [0, 6, 7, 8]) assert.equal(act(sent, HIGH), "send", `sent ${sent}`)
  // A reply to the user's own message is budgeted like a high-priority one (index.js alone lets it through a pause).
  for (const sent of [0, 8, 9, 10]) assert.deepEqual(decide(at(sent), REPLY), decide(at(sent), HIGH), `sent ${sent}`)
})

test("budget: the last slot is kept for the notice, once", () => {
  // 9 used: one send left. A high message does not take it; it is queued and the notice is due.
  assert.deepEqual(decide(at(9), HIGH), { act: "queue", notice: true })
  // Nothing left: queued, no notice possible.
  assert.deepEqual(decide(at(10), HIGH), { act: "queue", notice: false })
  assert.deepEqual(decide(at(12), HIGH), { act: "queue", notice: false })
  // The notice already went out for this token: no second one.
  assert.deepEqual(decide(at(9, { noticed: false }), HIGH), { act: "queue", notice: true })
  assert.equal(act(9, HIGH, 1, { noticed: true }), "send", "nothing left to keep a slot for")
  // An outbox flush stops where low priority stops, so a command reply still has its sends.
  for (const sent of [0, 5, 6]) assert.equal(act(sent, FLUSH), "send", `sent ${sent}`)
  for (const sent of [7, 9, 10]) assert.equal(act(sent, FLUSH), "stop", `sent ${sent}`)
})

test("budget: walking a token from fresh to exhausted drops low priority first", () => {
  const s = {}
  const trace = []
  const go = (prio) => {
    const d = decide(s, prio)
    if (d.act === "send") s.sent = (s.sent ?? 0) + 1
    if (d.act === "queue" && d.notice) ((s.noticed = true), (s.sent = (s.sent ?? 0) + 1))
    trace.push(`${prio}:${d.act}${d.notice ? "+notice" : ""}`)
  }
  for (let i = 0; i < 7; i++) go(LOW)
  assert.deepEqual(trace.slice(0, 8), Array(7).fill("low:send"))
  go(LOW)
  assert.equal(trace.at(-1), "low:skip", "the 8th progress push is dropped: 3 are left")
  go(HIGH)
  go(HIGH)
  go(HIGH)
  assert.deepEqual(trace.slice(-3), ["high:send", "high:send", "high:queue+notice"])
  assert.equal(s.sent, QUOTA, "the notice used the last send")
  go(HIGH)
  assert.equal(trace.at(-1), "high:queue", "and only one notice goes out")
})

test("adaptive progress interval: 15 s, then 60 s once half the allowance is used", () => {
  assert.equal(liveMs(0), 15_000)
  assert.equal(liveMs(4), 15_000)
  assert.equal(liveMs(5), 60_000)
  assert.equal(liveMs(9), 60_000)
  assert.equal(liveMs(), 15_000)
})

test("outbox: enqueue appends in order with ids and times", () => {
  const s = {}
  assert.equal(enqueue(s, { text: "a" }, 1000), 1)
  assert.equal(enqueue(s, { file: "C:\\x\\a.pdf", as: "file" }, 2000), 2)
  assert.equal(enqueue(s, { text: "b" }, 3000), 3)
  assert.deepEqual(s.outbox.map((e) => [e.text ?? e.file, e.at]), [["a", 1000], ["C:\\x\\a.pdf", 2000], ["b", 3000]])
  assert.equal(new Set(s.outbox.map((e) => e.id)).size, 3)
  assert.ok(s.outbox.every((e) => /^[0-9a-f]{8}$/.test(e.id)))
  assert.equal(s.lost, undefined)
})

test("outbox: entries expire after 24 hours and are counted", () => {
  const s = {}
  enqueue(s, { text: "old" }, 0)
  enqueue(s, { text: "newer" }, OUTBOX_TTL - 1000)
  assert.equal(alive(s.outbox, OUTBOX_TTL - 1).length, 2)
  assert.equal(alive(s.outbox, OUTBOX_TTL).length, 1, "exactly 24 h old is gone")
  // Enqueueing drops the expired ones first.
  assert.equal(enqueue(s, { text: "c" }, OUTBOX_TTL + 5), 2)
  assert.deepEqual(s.outbox.map((e) => e.text), ["newer", "c"])
  assert.equal(s.lost, 1)
  // expire() alone, and an emptied outbox leaves no key behind.
  expire(s, OUTBOX_TTL * 3)
  assert.equal(s.outbox, undefined)
  assert.equal(s.lost, 3)
})

test("outbox: capped at 20, the oldest goes first", () => {
  const s = {}
  for (let i = 1; i <= OUTBOX_MAX + 3; i++) enqueue(s, { text: `m${i}` }, 1000 + i)
  assert.equal(s.outbox.length, OUTBOX_MAX)
  assert.equal(s.outbox[0].text, "m4")
  assert.equal(s.outbox.at(-1).text, `m${OUTBOX_MAX + 3}`)
  assert.equal(s.lost, 3)
})

test("outbox flush order: texts merge up to one message, attachments stay where they were", () => {
  const items = [
    { id: "1", text: "[3] 完成 A" },
    { id: "2", text: "[4] 完成 B" },
    { id: "3", file: "C:\\r.pdf", as: "file" },
    { id: "4", text: "[3] 出错 C" },
    { id: "5", file: "C:\\p.png", as: "image" },
    { id: "6", text: "x".repeat(60) },
    { id: "7", text: "y".repeat(60) },
  ]
  assert.deepEqual(groups(items, 100), [
    { ids: ["1", "2"], text: "[3] 完成 A\n\n[4] 完成 B" },
    { ids: ["3"], file: "C:\\r.pdf", as: "file" },
    { ids: ["4"], text: "[3] 出错 C" },
    { ids: ["5"], file: "C:\\p.png", as: "image" },
    { ids: ["6"], text: "x".repeat(60) },
    { ids: ["7"], text: "y".repeat(60) },
  ], "order is kept; 60 + 60 does not fit in 100")
  assert.deepEqual(groups(items.slice(5), 200).map((g) => g.ids), [["6", "7"]])
  assert.deepEqual(groups([], 100), [])
  // A merged message never passes the size, and keeps blank-line paragraphs (WeChat shows a single "\n" as a space).
  const g = groups(Array.from({ length: 30 }, (_, i) => ({ id: String(i), text: `[1] 第 ${i} 条\n\n- a\n- b` })), 200)
  assert.ok(g.every((x) => x.text.length <= 200) && g.length > 1)
  assert.equal(g.flatMap((x) => x.ids).join(), Array.from({ length: 30 }, (_, i) => i).join(), "nothing lost, nothing reordered")
  assert.ok(g[0].text.includes("- b\n\n[1] 第 1 条"))
})

test("mergeTexts joins replies that fit one message and keeps the rest apart", () => {
  assert.deepEqual(mergeTexts(["a", "b", "c"], 100), ["a\n\nb\n\nc"])
  assert.deepEqual(mergeTexts(["a".repeat(60), "b".repeat(60), "c"], 100), ["a".repeat(60), `${"b".repeat(60)}\n\nc`])
  assert.deepEqual(mergeTexts(["a".repeat(150), "b"], 100), ["a".repeat(150), "b"], "a long one is not cut or joined onto")
  assert.deepEqual(mergeTexts([], 100), [])
})

test("file offer folds into the last chunk of the final reply when it fits", () => {
  const offer = "[3] OpenCode · p 这一轮的文件：\n\n- 1 a.pdf（2 KB）\n\n回复「3 文件 1 3」发送选中的"
  assert.deepEqual(foldOffer(["[3] h\n\n好了"], offer, 1800), [`[3] h\n\n好了\n\n${offer}`])
  // Several chunks: only the last one carries it.
  const out = foldOffer(["[3] h (1/2)\n\n" + "一".repeat(1000), "[3] (2/2)\n\n" + "二".repeat(1000)], offer, 1800)
  assert.equal(out.length, 2)
  assert.equal(out[0].includes("文件"), false)
  assert.ok(out[1].endsWith(offer))
  // Too long for the chunk size: no fold, the caller sends the offer on its own.
  assert.equal(foldOffer(["字".repeat(1800 - offer.length)], offer, 1800), null)
  assert.equal(foldOffer(["字".repeat(1800 - offer.length - 2)], offer, 1800)?.[0].length, 1800, "exactly the size still fits")
})

test("texts: notice, 额度 reply, skipped-progress note", () => {
  assert.equal(noticeText(3), "额度用完了：还有 3 条没发，回任意一句话就补发")
  assert.equal(quotaText({ sent: 4, outbox: [{ id: "a", at: Date.now(), text: "x" }] }), "已用 4/10，队列里 1 条")
  assert.equal(quotaText({}), "已用 0/10，队列里 0 条")
  assert.equal(quotaText({ sent: 14 }), "已用 10/10，队列里 0 条")
  assert.equal(quotaText({ sent: 1, outbox: [{ id: "a", at: 0, text: "old" }] }, OUTBOX_TTL + 1), "已用 1/10，队列里 0 条", "expired entries are not counted")
  assert.equal(skipNote(2, 3), "（有 2 段进度没推，看桌面端或「3 历史」）")
})
