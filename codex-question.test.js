import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fakeDesktop } from "./fake-desktop.js"
import {
  answerRequest, asyncAnswer, asyncText, desktopReply, dropQuestion, noteQuestion, openAsks, pendingQuestions, readQuestion, waitQuestion, writeQuestion,
} from "./codex-question.js"
import { agent, fakeHistory, sqlite, user } from "./fake-history.js"

// Shapes of the desktop's conversation state: `requests` holds app-server ServerRequests (ToolRequestUserInputParams).
const ask = (id, questions) => ({ method: "item/tool/requestUserInput", id, params: { threadId: "t1", turnId: "u1", itemId: "i1", questions } })
const COLOR = {
  id: "color", header: "颜色", question: "喜欢哪个颜色？", isOther: true, isSecret: false,
  options: [{ label: "红 (Recommended)", description: "r" }, { label: "蓝", description: "b" }],
}
const NUM = { id: "num", header: "数字", question: "一个数字", isOther: true, isSecret: false, options: null }
const approval = { method: "item/commandExecution/requestApproval", id: 3, params: {} }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "codex-q-"))

// A desktop that drops the question from its state when it gets the answer, like the real window.
const answering = (requests, onSubmit) =>
  fakeDesktop({
    owns: true,
    requests,
    onRequest(m) {
      if (m.method !== "thread-follower-submit-user-input") return
      onSubmit?.(m)
      const i = requests.findIndex((r) => r.id === m.params.requestId)
      if (i >= 0) requests.splice(i, 1)
    },
  })

test("pendingQuestions and the submit params", () => {
  const requests = [approval, ask(5, [COLOR]), { method: "item/plan/requestImplementation", id: "p" }, ask("r6", [NUM])]
  assert.deepEqual(pendingQuestions({ requests }).map((r) => r.id), [5, "r6"])
  assert.deepEqual(pendingQuestions({}), [])
  assert.deepEqual(pendingQuestions(null), [])
  assert.deepEqual(answerRequest("t1", ask(5, []), { color: "蓝", num: "42" }), [
    "thread-follower-submit-user-input",
    { conversationId: "t1", requestId: 5, response: { answers: { color: { answers: ["蓝"] }, num: { answers: ["42"] } } } },
  ])
})

test("question records: merge, expire, drop, stay inside the folder", () => {
  const dir = tmp()
  assert.equal(readQuestion(dir, "t1"), null)
  noteQuestion(dir, "t1", 4, [7])
  noteQuestion(dir, "t1", 4, [7, 8])
  const q = readQuestion(dir, "t1")
  assert.deepEqual([q.threadId, q.n, q.requestIds], ["t1", 4, [7, 8]])
  writeQuestion(dir, { ...q, progress: { id: 7, done: ["color"], answers: { color: "蓝" } } })
  noteQuestion(dir, "t1", 4, [9])
  assert.equal(readQuestion(dir, "t1").progress.done[0], "color", "progress survives another push")
  assert.equal(readQuestion(dir, "t1", Date.now() + 25 * 3600_000), null, "records expire after a day")
  assert.equal(readQuestion(dir, "t1"), null, "and are deleted when found expired")
  noteQuestion(dir, "../../evil", 1, [1])
  assert.deepEqual(fs.readdirSync(path.join(dir, "questions")), ["______evil.json"])
  dropQuestion(dir, "../../evil")
  assert.deepEqual(fs.readdirSync(path.join(dir, "questions")), [])
  fs.rmSync(dir, { recursive: true })
})

test("waitQuestion: waits for the request, skips known ones, null without a window", async () => {
  const requests = []
  const d = await fakeDesktop({ owns: true, requests })
  setTimeout(() => requests.push(approval, ask(7, [COLOR])), 80)
  const got = await waitQuestion("t1", [], { pipe: d.pipe, tries: 50, gap: 20 })
  assert.deepEqual(got.map((r) => r.id), [7])
  assert.deepEqual(await waitQuestion("t1", [7], { pipe: d.pipe, tries: 3, gap: 5 }), [])
  // The follow is always ended, even on the way out.
  const following = d.got.filter((m) => m.method === "thread-stream-following-changed").map((m) => m.params.following)
  assert.equal(following.at(-1), false)
  assert.equal(following.filter(Boolean).length, following.filter((f) => !f).length)
  d.close()
  const none = await fakeDesktop({ owns: false, requests })
  assert.equal(await waitQuestion("t1", [], { pipe: none.pipe, tries: 2, gap: 5 }), null)
  none.close()
  assert.equal(await waitQuestion("t1", [], { pipe: "\\\\.\\pipe\\wx-test-missing" }), null)
})

test("desktopReply: step by step, then one submit; the state is read back", { skip: process.platform !== "win32" }, async () => {
  const dir = tmp()
  const requests = [ask(7, [COLOR, NUM])]
  const d = await answering(requests)
  const tg = "[4] Codex · proj"
  const reply = (t) => desktopReply("t1", t, 4, tg, { dir, pipe: d.pipe, settleMs: 5 })
  const submits = () => d.got.filter((m) => m.method === "thread-follower-submit-user-input")
  noteQuestion(dir, "t1", 4, [7])
  assert.match(await reply("绿"), /^\[4\] Codex · proj 已记下 1\/2，下一个：\n问题 2\/2：数字：一个数字/, "free text answers a question that allows it")
  assert.deepEqual(readQuestion(dir, "t1").progress, { id: 7, done: ["color"], answers: { color: "绿" } })
  assert.deepEqual(submits(), [])
  assert.match(await reply("-"), /这一题必须回答/, "Codex questions can't be skipped")
  assert.match(await reply("忽略"), /没法忽略/)
  assert.equal(await reply("42"), "已回答 [4] Codex · proj")
  const [s] = submits()
  assert.equal(s.version, 1)
  assert.deepEqual(s.params, { conversationId: "t1", requestId: 7, response: { answers: { color: { answers: ["绿"] }, num: { answers: ["42"] } } } })
  assert.equal(readQuestion(dir, "t1"), null)
  assert.equal(await desktopReply("t1", "x", 4, tg, { dir, pipe: d.pipe }), null, "nothing waiting: the text is an ordinary message")
  // All questions in one message, an option by its number: the label is the answer.
  requests.push(ask(8, [COLOR, NUM]))
  noteQuestion(dir, "t1", 4, [8])
  assert.equal(await reply("1\n7"), "已回答 [4] Codex · proj")
  assert.deepEqual(submits()[1].params.response.answers, { color: { answers: ["红 (Recommended)"] }, num: { answers: ["7"] } })
  d.close()
  fs.rmSync(dir, { recursive: true })
})

test("desktopReply: an option-only question asks again", { skip: process.platform !== "win32" }, async () => {
  const dir = tmp()
  const requests = [ask(7, [{ ...COLOR, isOther: false }])]
  const d = await answering(requests)
  noteQuestion(dir, "t1", 4, [7])
  const reply = (t) => desktopReply("t1", t, 4, "[4]", { dir, pipe: d.pipe, settleMs: 5 })
  assert.match(await reply("绿"), /^\[4\] 「绿」不是选项，回编号或选项文字\n颜色：喜欢哪个颜色？/)
  assert.equal(d.got.filter((m) => m.method === "thread-follower-submit-user-input").length, 0)
  assert.equal(await reply("蓝"), "已回答 [4]")
  d.close()
  fs.rmSync(dir, { recursive: true })
})

test("desktopReply: answered on the computer first, window closed", { skip: process.platform !== "win32" }, async () => {
  const dir = tmp()
  const requests = []
  const d = await fakeDesktop({ owns: true, requests })
  noteQuestion(dir, "t1", 4, [7])
  assert.match(await desktopReply("t1", "蓝", 4, "[4] Codex · proj", { dir, pipe: d.pipe }), /^已经在电脑上回答了/)
  assert.equal(readQuestion(dir, "t1"), null, "the record is dropped, the next message is an ordinary one")
  assert.equal(d.got.filter((m) => m.method === "thread-follower-submit-user-input").length, 0)
  d.close()
  const gone = await fakeDesktop({ owns: false, requests })
  noteQuestion(dir, "t1", 4, [7])
  assert.match(await desktopReply("t1", "蓝", 4, "[4]", { dir, pipe: gone.pipe }), /已经没有这个对话了/)
  assert.equal(readQuestion(dir, "t1"), null)
  gone.close()
  noteQuestion(dir, "t1", 4, [7])
  assert.match(await desktopReply("t1", "蓝", 4, "[4]", { dir, pipe: "\\\\.\\pipe\\wx-test-missing" }), /已经没有这个对话了/)
  fs.rmSync(dir, { recursive: true })
})

// --- async questions (request_user_input_async), ordinals and shapes as in a real thread ---
const OPTS = [{ title: "再次测试", options: ["选项一", "选项二", "选项三"] }]
const FREE = [{ title: "几月？", options: null }]
const ASYNC_ITEMS = [
  ["t1", 86, user("u1", "再来一次")],
  ["t1", 92, agent("call_98dd6c80fb4e4aebb6345c686728f975", "再次测试\n- 选项一\n- 选项二\n- 选项三", OPTS)],
  ["t1", 96, agent("m1", "已发送 3 个选项，请选择其中一个。")],
  ["t2", 10, agent("call_other", "别的对话", FREE)],
]
const skipDb = { skip: !sqlite }

test("openAsks: open until the thread's next user message", skipDb, async () => {
  const open = [{ id: "call_98dd6c80fb4e4aebb6345c686728f975", questions: OPTS }]
  assert.deepEqual(await openAsks("t1", fakeHistory(ASYNC_ITEMS)), open)
  assert.deepEqual(await openAsks("t2", fakeHistory(ASYNC_ITEMS)), [{ id: "call_other", questions: FREE }])
  // Answered in the window: the answer is the next user message. A new question after it is open again.
  const answered = [...ASYNC_ITEMS, ["t1", 105, user("u2", "<send_user_message_question_reply>\n[]\n</send_user_message_question_reply>\n")]]
  assert.deepEqual(await openAsks("t1", fakeHistory(answered)), [])
  const again = [...answered, ["t1", 120, agent("call_next", "再问", FREE)]]
  assert.deepEqual(await openAsks("t1", fakeHistory(again)), [{ id: "call_next", questions: FREE }])
  assert.deepEqual(await openAsks("nobody", fakeHistory(ASYNC_ITEMS)), [])
  // No db, unreadable db: no question, never a throw.
  assert.deepEqual(await openAsks("t1", path.join(os.tmpdir(), "no-such-history.sqlite")), [])
})

test("asyncText: the whole question, numbered options, the reply hint", () => {
  assert.equal(asyncText({ questions: OPTS }, 12), "有问题问你：\n再次测试\n  1. 选项一\n  2. 选项二\n  3. 选项三\n回复「12 答案」（可以回编号，也可以直接写答案）")
  assert.equal(asyncText({ questions: FREE }, 3), "有问题问你：\n几月？\n回复「3 答案」")
  const long = "长".repeat(500)
  assert.ok(asyncText({ questions: [{ title: long, options: null }] }, 3).includes(long), "not cut at 300 characters")
  assert.equal(asyncText({ questions: [...FREE, ...OPTS] }, 4).split("\n").filter((l) => /^问题 \d\/2：/.test(l)).length, 2)
})

test("asyncAnswer: options resolve to their text, sent as the window sends an answer", skipDb, async () => {
  const db = fakeHistory(ASYNC_ITEMS)
  // Byte for byte what the desktop recorded when the user picked 选项三 (thread_history_1.sqlite, userMessage).
  const REAL =
    '<send_user_message_question_reply>\n[{"questionItemId":"[\\"request_user_input_async\\",\\"call_98dd6c80fb4e4aebb6345c686728f975\\",0]","question":"再次测试","answer":"选项三"}]\n</send_user_message_question_reply>\n'
  const a = (text) => asyncAnswer("t1", text, 12, "[12] Codex · proj", { db })
  assert.deepEqual(await a("3"), { text: REAL })
  assert.deepEqual(await a("选项三"), { text: REAL })
  assert.deepEqual(await a("选项 三 "), { text: REAL.replace("选项三", "选项 三") }, "free text stays free text")
  assert.match((await a("随便")).text, /"answer":"随便"/)
  // Out of range is free text, like everywhere else; empty and skip are not answers.
  assert.match((await a("9")).text, /"answer":"9"/)
  assert.match((await a("-")).reply, /^\[12\] Codex · proj 这一题必须回答/)
  // No open question (other thread without one, or answered): the caller sends the text as it is.
  assert.equal(await asyncAnswer("nobody", "3", 12, "[12]", { db }), null)
  assert.equal(await asyncAnswer("t1", "3", 12, "[12]", { db: fakeHistory([...ASYNC_ITEMS, ["t1", 105, user("u2", "好")]]) }), null)
  assert.equal(await asyncAnswer("t1", "3", 12, "[12]", { db: path.join(os.tmpdir(), "no-such-history.sqlite") }), null)
})

test("asyncAnswer: several questions in one message, one line each", skipDb, async () => {
  const db = fakeHistory([["t1", 5, agent("call_two", "两个问题", [...FREE, ...OPTS])]])
  const a = (text) => asyncAnswer("t1", text, 4, "[4]", { db })
  const r = await a("8月\n2")
  const sent = JSON.parse(r.text.split("\n")[1])
  assert.deepEqual(sent.map((s) => [JSON.parse(s.questionItemId)[2], s.question, s.answer]), [[0, "几月？", "8月"], [1, "再次测试", "选项二"]])
  assert.match((await a("8月")).reply, /^\[4\] 有 2 个问题，要一次回完/)
})

test("desktopReply: a rejected or ignored answer is an error and keeps the progress", { skip: process.platform !== "win32" }, async () => {
  const dir = tmp()
  const requests = [ask(7, [COLOR])]
  let mode = "reject"
  const d = await fakeDesktop({
    owns: true,
    requests,
    onRequest: (m) => (m.method === "thread-follower-submit-user-input" && mode === "reject" ? { resultType: "error", error: "no-handler-for-request" } : undefined),
  })
  noteQuestion(dir, "t1", 4, [7])
  const reply = (t) => desktopReply("t1", t, 4, "[4]", { dir, pipe: d.pipe, settleMs: 2 })
  await assert.rejects(reply("蓝"), /电脑上的 Codex 拒绝了：no-handler-for-request/)
  assert.ok(readQuestion(dir, "t1"), "the question is still waiting")
  // Accepted but still in the window's state (the real window answers ok even for a request it no longer has).
  mode = "ignore"
  await assert.rejects(reply("蓝"), /窗口里的提问还在/)
  assert.ok(readQuestion(dir, "t1"))
  d.close()
  fs.rmSync(dir, { recursive: true })
})
