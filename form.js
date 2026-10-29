// Answering OpenCode forms and Codex questions from WeChat: all at once (one line per question) or one per message.
export const YES = /^(y|yes|是|批准|同意)$/i
export const NO = /^(n|no|否|不|拒绝)$/i
export const CANCEL = /^(忽略|取消|cancel)$/i
const SKIP = /^(-|－|—|跳过|skip)$/i
// "1. 蓝", "2) 5", "3：无"; "1.5" stays a number and "1、2" stays a multiselect answer.
const NUMBERED = /^(\d{1,2})(?:[)）:：．]|\.(?!\d))\s*(.+)$/
// "「1」" or "\"1\"": free text that would otherwise be read as option 1.
const QUOTED = /^["“「'](.*)["”」']$/s

const cut = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim()
  return t.length > n ? t.slice(0, n - 1) + "…" : t
}

// Fields WeChat can answer, in order: not hidden, not external links, and shown for the answers so far.
export const fieldsOf = (form, answers = {}) =>
  (form?.fields ?? []).filter(
    (f) => !f.hidden && f.type !== "external" && (f.when ?? []).every((w) => (w.op === "neq") !== (answers[w.key] === w.value)),
  )

// Same rule as the server: a field without `required: true` may be left out (the question tool never sets it).
export const optional = (f) => f.required !== true

// Codex request_user_input questions as a form: every one answered, options answer with their label, isOther (or no
// options) allows text.
export const questionForm = (questions) => ({
  fields: (questions ?? []).map((q) => ({
    key: q.id,
    type: "string",
    title: q.header,
    description: q.question,
    required: true,
    options: (q.options ?? []).map((o) => ({ value: o.label, label: o.label })),
    custom: !!q.isOther || !q.options?.length,
    secret: !!q.isSecret,
  })),
})

const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s*[(（]recommended[)）]$/, "")
const option = (f, s) => {
  const o = f.options ?? []
  return /^\d+$/.test(s) ? o[Number(s) - 1] : o.find((x) => norm(x.label) === norm(s) || norm(x.value) === norm(s))
}
const notOption = (s) => `「${cut(s, 30)}」不是选项，回编号或选项文字`

// { value } for one field's answer text, or { error }.
export function parseValue(f, text) {
  const t = String(text ?? "").trim()
  if (!t) return { error: "没有内容" }
  switch (f.type) {
    case "boolean":
      return YES.test(t) ? { value: true } : NO.test(t) ? { value: false } : { error: "回「是」或「否」" }
    case "number":
    case "integer": {
      const v = Number(t)
      if (Number.isFinite(v) && (f.type === "number" || Number.isInteger(v))) return { value: v }
      return { error: f.type === "integer" ? "要填整数" : "要填数字" }
    }
    case "multiselect": {
      const value = []
      for (const s of t.split(/[\s,，、]+/).filter(Boolean)) {
        const o = option(f, s)
        if (!o && !f.custom) return { error: notOption(s) }
        value.push(o ? o.value : s)
      }
      return { value }
    }
    default: {
      const q = f.custom && t.match(QUOTED)
      if (q) return { value: q[1] }
      const o = f.options?.length ? option(f, t) : null
      if (o) return { value: o.value }
      return f.options?.length && !f.custom ? { error: notOption(t) } : { value: t }
    }
  }
}

// Question i of total, its options and what it accepts.
export function fieldLines(f, i, total) {
  const tags = [
    optional(f) && "可跳过",
    { number: "填数字", integer: "填整数", boolean: "回 是/否", multiselect: "可多选，用逗号隔开" }[f.type],
    f.custom && f.options?.length && "也可以直接写答案",
    f.secret && "保密内容，会经过微信",
  ].filter(Boolean)
  const head = cut([f.title, f.description].filter(Boolean).join("：") || f.key, 300)
  return [
    `${total > 1 ? `问题 ${i}/${total}：` : ""}${head}${tags.length ? `（${tags.join("，")}）` : ""}`,
    ...(f.options ?? []).map((o, k) => `  ${k + 1}. ${cut(o.label, 80)}`),
  ].join("\n")
}

// Push text for a new form. `cancel`: whether 「N 忽略」 works (OpenCode forms). The question tool's title is
// always "Questions", so only other forms show theirs.
export function formText(form, n, cancel = true) {
  const fs = fieldsOf(form)
  const title = form?.metadata?.kind === "question" ? "" : cut(form?.title, 200)
  const lines = [`有问题问你：${title}`, ...fs.map((f, i) => fieldLines(f, i + 1, fs.length))]
  if (fs.length > 1) {
    const skip = fs.some(optional) ? "；跳过回「-」" : ""
    lines.push(`回复「${n} 答案」：一次回完就一行一个、按顺序（或「1. 答案」），也可以一条一个${skip}`)
  } else lines.push(`回复「${n} 答案」${fs[0]?.options?.length ? "（可以回编号）" : ""}`)
  if (cancel) lines.push(`不想回答发「${n} 忽略」`)
  return lines.join("\n")
}

const todo = (form, p) => fieldsOf(form, p.answers).filter((f) => !p.done.includes(f.key))

// Applies a WeChat message to the form. `progress` is { done: [keys], answers } from earlier messages.
// Returns { error, field, progress } (nothing applied), or { progress, next } where next is the next question or null
// when done.
export function step(form, progress, text) {
  const before = { done: [...(progress?.done ?? [])], answers: { ...progress?.answers } }
  const p = { done: [...before.done], answers: { ...before.answers } }
  const all = fieldsOf(form, p.answers)
  const left = todo(form, p)
  const whole = String(text ?? "").trim()
  const lines = whole.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  // Errors carry the progress from before this message, so the question asked again is numbered as before.
  const fail = (error, field) => ({ error, field, progress: before })
  if (!lines.length) return fail("没有内容", left[0])
  const nums = lines.map((l) => l.match(NUMBERED))
  let pairs
  if (all.length > 1 && nums.every((m) => m && all[Number(m[1]) - 1])) pairs = nums.map((m) => [all[Number(m[1]) - 1], m[2]])
  else if (left.length <= 1) pairs = [[left[0], whole]]
  else if (lines.length > left.length) return fail(`还剩 ${left.length} 个问题，你回了 ${lines.length} 行；一行一个、按顺序`, left[0])
  else pairs = lines.map((l, i) => [left[i], l])
  if (!pairs[0][0]) return fail("没有要回答的问题")
  // ponytail: lines map to the questions shown before this message; a `when` they change applies from the next one.
  for (const [f, t] of pairs) {
    const q = all.length > 1 ? `第 ${all.indexOf(f) + 1} 题：` : ""
    if (SKIP.test(t.trim())) {
      if (!optional(f)) return fail(`${q}这一题必须回答`, f)
      delete p.answers[f.key]
    } else {
      const r = parseValue(f, t)
      if (r.error) return fail(q + r.error, f)
      p.answers[f.key] = r.value
    }
    if (!p.done.includes(f.key)) p.done.push(f.key)
  }
  return { progress: p, next: todo(form, p)[0] ?? null }
}

// WeChat text for a step that didn't finish the form: the error and the question again, or the next question.
export function stepText(form, n, r, tag = `[${n}]`) {
  const all = fieldsOf(form, r.progress?.answers)
  const ask = (f) => fieldLines(f, all.indexOf(f) + 1, all.length)
  if (r.error) return `${tag} ${r.error}${r.field ? `\n${ask(r.field)}` : ""}`
  const k = all.filter((f) => r.progress.done.includes(f.key)).length
  return `${tag} 已记下 ${k}/${all.length}，下一个：\n${ask(r.next)}\n回复「${n} 答案」`
}

// What a WeChat message does to a pending form; never a prompt. `numbered`: the message had 「N 」 in front;
// `decision`: it was 「N y/n」 with no permission pending. `cancel`: hint 「N 忽略」 (OpenCode only).
// `tag`: how replies name the conversation ("[7] OpenCode · PCB"); the line appended after another reply that already
// starts with it says just "[7]".
// Returns { cancel }, { reply } (nothing changes), { save, reply } (progress), or { submit: answer }.
export function formAction(form, progress, text, n, { numbered = true, decision = false, cancel = true, tag = `[${n}]` } = {}) {
  const wait = cancel ? `\n[${n}] 在等你回答问题，回答或发「${n} 忽略」` : ""
  const p = progress?.id === form.id ? progress : null
  if (CANCEL.test(text.trim())) {
    if (!cancel) return { reply: `${tag} 这个提问没法忽略，回答它，或发「${n} /stop」停止这一轮` }
    return numbered ? { cancel: true } : { reply: `要忽略 ${tag} 的问题请发「${n} 忽略」` }
  }
  const cur = todo(form, { done: p?.done ?? [], answers: p?.answers ?? {} })[0]
  if (decision && cur?.type !== "boolean") return { reply: `${tag} 没有待批准的请求${wait}` }
  const r = step(form, p, text)
  if (r.error) return { reply: stepText(form, n, r, tag) + wait }
  if (r.next) return { save: { id: form.id, ...r.progress }, reply: stepText(form, n, r, tag) }
  return { submit: r.progress.answers }
}
