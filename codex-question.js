// Questions (request_user_input) asked in the Codex desktop window. The PreToolUse hook in codex-hook.js pushes them to
// WeChat and leaves a record; the plugin answers them through the desktop's IPC pipe. A file of its own, so a
// hot-reloaded index.js still loads next to an older codex.js.
import fs from "node:fs"
import path from "node:path"
import { desktopSnapshot, ipcConnect, ownerOf, questionResult } from "./codex.js"
import { formAction, questionForm } from "./form.js"

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
