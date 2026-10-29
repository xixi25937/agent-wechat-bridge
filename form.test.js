import assert from "node:assert/strict"
import { test } from "node:test"
import { fieldsOf, formAction, formText, parseValue, questionForm, step } from "./form.js"
import { looseBreaks } from "./md.js"

// WeChat shows a single "\n" as a space; only blank lines and "- " items lay out.
const flat = (...msgs) => msgs.forEach((m) => assert.deepEqual(looseBreaks(m), [], `single \\n in: ${JSON.stringify(m)}`))

// Shape of a form the OpenCode question tool creates (2.0.32): string fields, `custom` for 「Type your own answer」.
const opt = (...labels) => labels.map((l) => ({ value: l, label: l, description: "" }))
const qform = {
  id: "frm_1",
  title: "Questions",
  metadata: { kind: "question" },
  fields: [
    { key: "q0", type: "string", title: "页面颜色", description: "你喜欢哪种？", options: opt("浅色 (Recommended)", "深色"), custom: true },
    { key: "q1", type: "string", title: "用哪个工程", description: "我在哪里画？", options: opt("新建工程", "就用当前工程"), custom: true },
    { key: "q2", type: "string", title: "另一个 agent", description: "停了吗？", options: opt("已经停了", "还在跑"), custom: true },
  ],
}

test("formText lists every question", () => {
  const t = formText(qform, 7)
  // Each question is a paragraph, its options are bullets with the number kept visible, each hint is a paragraph.
  assert.equal(
    t,
    [
      "有问题问你：",
      "问题 1/3：页面颜色：你喜欢哪种？（可跳过，也可以直接写答案）",
      "- 1 浅色 (Recommended)\n- 2 深色",
      "问题 2/3：用哪个工程：我在哪里画？（可跳过，也可以直接写答案）",
      "- 1 新建工程\n- 2 就用当前工程",
      "问题 3/3：另一个 agent：停了吗？（可跳过，也可以直接写答案）",
      "- 1 已经停了\n- 2 还在跑",
      "回复「7 答案」：一次回完就一行一个、按顺序（或「1. 答案」），也可以一条一个；跳过回「-」",
      "不想回答发「7 忽略」",
    ].join("\n\n"),
  )
  const req = { id: "f", title: "部署", fields: [{ key: "n", type: "integer", title: "副本数", required: true }, { key: "x", type: "external", url: "u" }] }
  assert.equal(formText(req, 2), "有问题问你：部署\n\n副本数（填整数）\n\n回复「2 答案」\n\n不想回答发「2 忽略」")
  flat(t, formText(req, 2))
})

test("one message, one line per question", () => {
  // What the user actually sent to [7], as one message.
  assert.deepEqual(formAction(qform, null, "1\n就用当前工程\n已经停了", 7), {
    submit: { q0: "浅色 (Recommended)", q1: "就用当前工程", q2: "已经停了" },
  })
  // Numbered lines in any order; label match ignores case and the (Recommended) suffix; free text is kept.
  assert.deepEqual(formAction(qform, null, "3. 还在跑\n1. 浅色\n2：另一个自己停了，用这个", 7).submit, {
    q0: "浅色 (Recommended)", q1: "另一个自己停了，用这个", q2: "还在跑",
  })
  assert.deepEqual(formAction(qform, null, "2\n-\n跳过", 7).submit, { q0: "深色" })
  assert.match(formAction(qform, null, "1\n2\n1\n2", 7).reply, /^\[7\] 还剩 3 个问题，你回了 4 行/)
})

test("step by step", () => {
  // The two messages the user sent: the first is question 1, the second answers question 2 as free text.
  const a = formAction(qform, null, "1", 7)
  assert.deepEqual(a.save, { id: "frm_1", done: ["q0"], answers: { q0: "浅色 (Recommended)" } })
  assert.match(a.reply, /^\[7\] 已记下 1\/3，下一个：\n\n问题 2\/3：用哪个工程/)
  const b = formAction(qform, a.save, "就用这个工程，另一个自己停了", 7)
  assert.deepEqual(b.save.answers, { q0: "浅色 (Recommended)", q1: "就用这个工程，另一个自己停了" })
  assert.match(b.reply, /^\[7\] 已记下 2\/3，下一个：\n\n问题 3\/3/)
  flat(a.reply, b.reply)
  // Two lines can finish what is left.
  const c = formAction(qform, a.save, "2\n1", 7)
  assert.deepEqual(c.submit, { q0: "浅色 (Recommended)", q1: "就用当前工程", q2: "已经停了" })
  assert.deepEqual(formAction(qform, b.save, "-", 7), { submit: b.save.answers })
  // Progress of another form is ignored.
  assert.match(formAction(qform, { ...a.save, id: "frm_old" }, "1", 7).reply, /已记下 1\/3/)
})

test("cancel, and nothing turns into a prompt", () => {
  assert.deepEqual(formAction(qform, null, "忽略", 7), { cancel: true })
  assert.deepEqual(formAction(qform, null, "取消", 7), { cancel: true })
  assert.match(formAction(qform, null, "忽略", 7, { numbered: false }).reply, /发「7 忽略」/)
  // 「7 y」 with no permission pending is not taken as an answer.
  assert.equal(formAction(qform, null, "y", 7, { decision: true }).reply, "[7] 没有待批准的请求\n\n[7] 在等你回答问题，回答或发「7 忽略」")
  // With a tag: the reply starts with it, and the 「N 忽略」 hint paragraph after it says just [7]; typed numbers stay plain.
  const tg = "[7] OpenCode · todo-app"
  assert.equal(formAction(qform, null, "y", 7, { decision: true, tag: tg }).reply, `${tg} 没有待批准的请求\n\n[7] 在等你回答问题，回答或发「7 忽略」`)
  assert.equal(formAction(qform, null, "忽略", 7, { numbered: false, tag: tg }).reply, `要忽略 ${tg} 的问题请发「7 忽略」`)
  assert.match(formAction(qform, null, "1", 7, { tag: tg }).reply, /^\[7\] OpenCode · todo-app 已记下 1\/3，下一个：\n\n.*\n\n回复「7 答案」$/s)
  assert.equal(formAction(qform, null, "忽略", 4, { cancel: false, tag: "[4] Codex · proj" }).reply, "[4] Codex · proj 这个提问没法忽略，回答它，或发「4 /stop」停止这一轮")
  const strict = { id: "f", fields: [{ key: "c", type: "string", required: true, options: opt("红", "蓝") }] }
  const r = formAction(strict, null, "绿", 3)
  assert.equal(r.reply, "[3] 「绿」不是选项，回编号或选项文字\n\nc\n\n- 1 红\n- 2 蓝\n\n[3] 在等你回答问题，回答或发「3 忽略」")
  flat(r.reply)
  assert.match(formAction(strict, null, "-", 3).reply, /这一题必须回答/)
  assert.match(formAction(strict, null, "9", 3).reply, /「9」不是选项/)
  assert.deepEqual(formAction(strict, null, "蓝", 3), { submit: { c: "蓝" } })
})

test("parseValue", () => {
  const sel = { key: "db", type: "string", options: [{ value: "pg", label: "Postgres" }, { value: "my", label: "MySQL" }] }
  assert.deepEqual(parseValue(sel, "2"), { value: "my" })
  assert.deepEqual(parseValue(sel, "postgres"), { value: "pg" })
  assert.match(parseValue(sel, "随便").error, /不是选项/)
  assert.deepEqual(parseValue({ ...sel, custom: true }, "随便"), { value: "随便" })
  assert.deepEqual(parseValue({ ...sel, custom: true }, "「2」"), { value: "2" })
  assert.deepEqual(parseValue({ key: "t", type: "string" }, "2"), { value: "2" })
  assert.deepEqual(parseValue({ key: "ok", type: "boolean" }, "是"), { value: true })
  assert.match(parseValue({ key: "ok", type: "boolean" }, "也许").error, /是/)
  assert.deepEqual(parseValue({ key: "n", type: "integer" }, "5"), { value: 5 })
  assert.match(parseValue({ key: "n", type: "integer" }, "1.5").error, /整数/)
  assert.deepEqual(parseValue({ key: "n", type: "number" }, "1.5"), { value: 1.5 })
  assert.deepEqual(parseValue({ key: "m", type: "multiselect", options: sel.options }, "1，MySQL"), { value: ["pg", "my"] })
  assert.deepEqual(parseValue({ key: "m", type: "multiselect", options: sel.options }, "1、2"), { value: ["pg", "my"] })
  assert.match(parseValue({ key: "m", type: "multiselect", options: sel.options }, "1 x").error, /「x」不是选项/)
})

test("when, hidden and numbers in answers", () => {
  const f = {
    id: "f",
    fields: [
      { key: "t", type: "boolean", required: true },
      { key: "why", type: "string", when: [{ key: "t", op: "eq", value: true }] },
      { key: "h", type: "string", hidden: true },
      { key: "n", type: "number", required: true },
    ],
  }
  assert.deepEqual(fieldsOf(f).map((x) => x.key), ["t", "n"])
  assert.deepEqual(fieldsOf(f, { t: true }).map((x) => x.key), ["t", "why", "n"])
  const a = step(f, null, "是")
  assert.equal(a.next.key, "why")
  assert.deepEqual(step(f, a.progress, "原因\n1.5").progress.answers, { t: true, why: "原因", n: 1.5 })
  // A rejected line is asked again with the numbering of the questions shown so far.
  assert.match(formAction(f, { id: "f", ...a.progress }, "原因\n很多", 1).reply, /^\[1\] 第 3 题：要填数字\n\n问题 3\/3：n（填数字）/)
  assert.deepEqual(step(f, null, "否\n2").progress.answers, { t: false, n: 2 })
  // 「1.5」 is a number, not "question 1: 5".
  assert.deepEqual(step({ id: "g", fields: [{ key: "n", type: "number" }, { key: "s", type: "string" }] }, null, "1.5\nx").progress.answers, { n: 1.5, s: "x" })
  // A yes/no question takes 「N y」 even with no permission pending.
  assert.deepEqual(formAction({ id: "b", fields: [{ key: "ok", type: "boolean" }] }, null, "y", 1, { decision: true }), { submit: { ok: true } })
})

test("Codex questions", () => {
  const form = questionForm([
    { id: "a", header: "颜色", question: "选一个", isOther: false, isSecret: false, options: [{ label: "红", description: "" }] },
    { id: "b", header: "名字", question: "叫什么", isOther: false, isSecret: true, options: null },
    { id: "c", header: "其他", question: "还有吗", isOther: true, options: [{ label: "没有", description: "" }] },
  ])
  const t = formText(form, 4, false)
  assert.ok(!t.includes("忽略") && !t.includes("跳过"))
  assert.match(t, /问题 2\/3：名字：叫什么（保密内容，会经过微信）/)
  assert.match(t, /问题 1\/3：颜色：选一个\n\n- 1 红\n\n问题 2\/3/)
  flat(t)
  assert.match(formAction(form, null, "蓝\nx\ny", 4, { cancel: false }).reply, /^\[4\] 第 1 题：「蓝」不是选项/)
  assert.deepEqual(formAction(form, null, "1\n小明\n自己写的", 4, { cancel: false }), { submit: { a: "红", b: "小明", c: "自己写的" } })
})
