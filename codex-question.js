// Questions (request_user_input) asked in the Codex desktop window. The PreToolUse hook in codex-hook.js pushes them to
// WeChat and leaves a record; the plugin answers them through the desktop's IPC pipe. A file of its own, so a
// hot-reloaded index.js still loads next to an older codex.js.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { desktopSnapshot, ipcConnect, ownerOf, questionResult } from "./codex.js"
import { fieldsOf, formAction, questionForm, step, stepText } from "./form.js"
import { md, numbered } from "./md.js"

const QUESTION = "item/tool/requestUserInput"
// A question can wait for the user a long time; the Stop hook and every answer remove the record sooner.
const TTL = 24 * 60 * 60_000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Pending questions in a desktop snapshot (the `requests` of the conversation state), oldest first.
export const pendingQuestions = (state) => (state?.requests ?? []).filter((r) => r.method === QUESTION)

// [ipc method, params] that answers a desktop question: the call the desktop's own follower windows send.
export const answerRequest = (threadId, req, answers) => [
  "thread-follower-submit-user-input",
  { conversationId: threadId, requestId: req.id, response: questionResult(answers) },
]

// --- records: one file per thread in <pending dir>/questions, { threadId, n, requestIds, created, progress? } ---

const file = (dir, threadId) => path.join(dir, "questions", `${String(threadId).replace(/[^\w-]/g, "_")}.json`)

export const dropQuestion = (dir, threadId) => fs.rmSync(file(dir, threadId), { force: true })

export function readQuestion(dir, threadId, now = Date.now()) {
  let q
  try {
    q = JSON.parse(fs.readFileSync(file(dir, threadId), "utf-8"))
  } catch {
    return null
  }
  if (now - q.created <= TTL) return q
  dropQuestion(dir, threadId)
  return null
}

export function writeQuestion(dir, q) {
  fs.mkdirSync(path.join(dir, "questions"), { recursive: true })
  fs.writeFileSync(file(dir, q.threadId), JSON.stringify(q))
}

// The hook pushed these requests: remember them, so a WeChat reply knows a question waits and they aren't pushed twice.
export function noteQuestion(dir, threadId, n, requestIds, now = Date.now()) {
  const old = readQuestion(dir, threadId, now)
  writeQuestion(dir, { threadId, n, requestIds: [...new Set([...(old?.requestIds ?? []), ...requestIds])], created: now, progress: old?.progress })
}

// --- hook side ---

// Questions in the window's state for the thread that aren't in `known` yet. The hook runs just before the window gets
// the request, so this waits up to tries × gap ms for it. null: no desktop window has the thread (a terminal); []: none showed up.
export async function waitQuestion(threadId, known = [], { pipe, tries = 30, gap = 1000 } = {}) {
  const ipc = await ipcConnect(pipe)
  if (!ipc) return null
  try {
    if (!(await ownerOf(ipc, threadId))) return null
    for (let i = 0; i < tries; i++) {
      const fresh = pendingQuestions(await desktopSnapshot(ipc, threadId)).filter((r) => !known.includes(r.id))
      if (fresh.length) return fresh
      await sleep(gap)
    }
    return []
  } finally {
    ipc.close()
  }
}

// --- async questions: the desktop's request_user_input_async ---
// Not a request waiting in the window: the tool returns at once, the model's turn ends, and the question is an
// agentMessage item (`delivery: "async"`, `questions: [{ title, options: [string] | null }]`). The window sends the answer
// as the next user message, wrapped in <send_user_message_question_reply>. So a question is open until the thread's next
// userMessage, and nothing is stored: the history db is the state.

const HISTORY = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "thread_history_1.sqlite")
const OPEN_ASKS =
  "select item_id as id, json_extract(item_json, '$.questions') as q from thread_items" +
  " where thread_id = ? and item_type = 'agentMessage' and json_extract(item_json, '$.delivery') = 'async'" +
  " and json_extract(item_json, '$.questions') is not null and rollout_ordinal >" +
  " coalesce((select max(rollout_ordinal) from thread_items where thread_id = ? and item_type = 'userMessage'), -1)" +
  " order by rollout_ordinal"

// Async questions the user hasn't answered yet, oldest first: [{ id, questions }]. [] when the db can't be read
// (old Node without node:sqlite, db locked or missing).
export async function openAsks(threadId, db = HISTORY) {
  try {
    const { DatabaseSync } = await import("node:sqlite")
    const conn = new DatabaseSync(db, { readOnly: true })
    try {
      return conn.prepare(OPEN_ASKS).all(threadId, threadId).map((r) => ({ id: r.id, questions: JSON.parse(r.q) })).filter((a) => a.questions.length)
    } finally {
      conn.close()
    }
  } catch {
    return []
  }
}

// Push text for one open question. The whole question is shown (the form text cuts at 300 characters).
export function asyncText({ questions }, n) {
  const many = questions.length > 1
  return md(
    "有问题问你：",
    ...questions.map((q, i) => md(`${many ? `问题 ${i + 1}/${questions.length}：` : ""}${q.title}`, q.options?.length && numbered(q.options))),
    many ? `回复「${n} 答案」：一次回完，一行一个、按顺序` : `回复「${n} 答案」${questions[0].options?.length ? "（可以回编号，也可以直接写答案）" : ""}`,
  )
}

// Options answer with their text; anything else is the answer itself, as the window's "other" would be.
const asyncForm = (questions) => ({
  fields: questions.map((q, i) => ({
    key: String(i), type: "string", description: q.title, required: true,
    options: (q.options ?? []).map((o) => ({ value: o, label: o })), custom: true,
  })),
})

// The user message the window sends for an answer (byte for byte, as recorded in the history db).
export const asyncReplyText = (ask, answers) =>
  "<send_user_message_question_reply>\n" +
  JSON.stringify(ask.questions.map((q, i) => ({ questionItemId: JSON.stringify(["request_user_input_async", ask.id, i]), question: q.title, answer: answers[i] }))) +
  "\n</send_user_message_question_reply>\n"

// A WeChat message to a thread with an open async question: { text } to send in the window's answer format, { reply }
// to send back instead (nothing is sent), or null when no question is open. Several questions are answered in one
// message, one line each (no progress is kept).
export async function asyncAnswer(threadId, text, n, tag = `[${n}]`, { db } = {}) {
  const ask = (await openAsks(threadId, db)).at(-1)
  if (!ask) return null
  const form = asyncForm(ask.questions)
  const r = step(form, null, text)
  if (r.error) return { reply: stepText(form, n, r, tag) }
  if (r.next) return { reply: `${tag} 有 ${fieldsOf(form).length} 个问题，要一次回完：一行一个、按顺序` }
  return { text: asyncReplyText(ask, ask.questions.map((_, i) => r.progress.answers[i])) }
}

// --- plugin side ---

// WeChat text for a thread whose window question the hook pushed: one line per question at once, or one per message
// (progress is kept in the record). Returns the reply ("已回答 …" once submitted), or null when no record exists.
// Throws with the desktop's reason when it rejects the answer; the progress before the last message stays.
export async function desktopReply(threadId, text, n, tag = `[${n}]`, { dir, pipe, settleMs = 500 } = {}) {
  const rec = readQuestion(dir, threadId)
  if (!rec) return null
  const ipc = await ipcConnect(pipe)
  try {
    if (!ipc || !(await ownerOf(ipc, threadId))) {
      dropQuestion(dir, threadId)
      return `${tag} 电脑上的 Codex 窗口已经没有这个对话了，提问作废，你这条没有发出`
    }
    const req = pendingQuestions(await desktopSnapshot(ipc, threadId))[0]
    if (!req) {
      dropQuestion(dir, threadId)
      return `已经在电脑上回答了（你这条没有发出，要发给 ${tag} 请再发一次）`
    }
    // Same parsing as every other form; Codex questions can't be ignored, only answered (or stopped with /stop).
    const a = formAction({ id: req.id, ...questionForm(req.params?.questions) }, rec.progress, text, n, { cancel: false, tag })
    if (a.save) writeQuestion(dir, { ...rec, progress: a.save })
    if (!a.submit) return a.reply
    const res = await ipc.request(...answerRequest(threadId, req, a.submit), 30_000)
    if (res.resultType !== "success") throw new Error(`电脑上的 Codex 拒绝了：${res.error}`)
    // The window says ok even for a request that was already gone, so read the state back.
    for (let i = 0; i < 6; i++) {
      if (!pendingQuestions(await desktopSnapshot(ipc, threadId)).some((r) => r.id === req.id)) {
        dropQuestion(dir, threadId)
        return `已回答 ${tag}`
      }
      await sleep(settleMs)
    }
    throw new Error("电脑上的 Codex 收到了回答，但窗口里的提问还在，请在电脑上处理")
  } finally {
    ipc?.close()
  }
}
