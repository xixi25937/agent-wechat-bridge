import assert from "node:assert/strict"
import { getEventListeners } from "node:events"
import { test } from "node:test"
import { clip, eventKey, format, formAnswer, historyLines, imagePaths, inboundText, parseCommand, pickDir, replyText, sessionIDOf, shouldSend, sleep } from "./index.js"

const session = { id: "s1", title: "重构登录模块", location: { directory: "C:\\Users\\me\\22" } }
const ok = { type: "session.execution.succeeded", data: { sessionID: "s1" } }

test("format", () => {
  assert.equal(format(ok, session, 3, "改好了"), "[3] 22 / 重构登录模块\n改好了")
  assert.equal(format(ok, session, 3, ""), "[3] 22 / 重构登录模块\n完成（没有文字回复）")
  assert.equal(format(ok, { ...session, parentID: "p" }, 3, "x"), null)
  assert.equal(format({ ...ok, location: { directory: "/a/b" } }, undefined, 1, "x"), "[1] b / 未命名会话\nx")
  assert.equal(
    format({ type: "session.execution.failed", data: { error: { type: "x", message: "rate\nlimited" } } }, session, 3),
    "[3] 22 / 重构登录模块\n出错：rate limited",
  )
  assert.equal(
    format({ type: "permission.asked", data: { action: "shell", resources: ["git push"] } }, session, 3),
    "[3] 22 / 重构登录模块\n等你批准：shell git push\n回复「3 y」批准一次，「3 n」拒绝",
  )
  const fields = [{ key: "db", type: "string", title: "选数据库", options: [{ value: "pg", label: "Postgres" }] }]
  const form = { type: "form.created", data: { form: { sessionID: "s1", title: "用哪个数据库？", fields } } }
  assert.equal(format(form, session, 3), "[3] 22 / 重构登录模块\n有问题问你：用哪个数据库？\n选数据库\n  1. Postgres\n回复「3 答案」（可以回编号）")
  assert.equal(sessionIDOf(form), "s1")
})

test("clip", () => {
  assert.equal(clip(" hi "), "hi")
  const long = clip("x".repeat(2000))
  assert.ok(long.startsWith("x".repeat(1500) + "\n…（已截断，共 2000 字"))
})

test("replyText", () => {
  const a = (...texts) => ({ type: "assistant", content: texts.map((t) => (t ? { type: "text", text: t } : { type: "tool" })) })
  const user = { type: "user", text: "q" }
  assert.equal(replyText([a(null), a("最终", "回复"), user, a("旧的")]), "最终\n回复")
  assert.equal(replyText([a(null), user, a("旧的")]), "")
  assert.equal(replyText([a(null), user, a("旧的")], false), "旧的")
  assert.equal(replyText([{ type: "assistant", content: [{ type: "reasoning", text: "想" }] }]), "")
})

test("parseCommand", () => {
  assert.deepEqual(parseCommand("列表"), { type: "list" })
  assert.deepEqual(parseCommand("/list"), { type: "list" })
  assert.deepEqual(parseCommand("帮助"), { type: "help" })
  assert.deepEqual(parseCommand(" 3 "), { type: "show", n: 3 })
  assert.deepEqual(parseCommand("3 继续改\n第二行"), { type: "text", n: 3, text: "继续改\n第二行" })
  assert.deepEqual(parseCommand("3：y"), { type: "text", n: 3, text: "y" })
  assert.deepEqual(parseCommand("看看日志"), { type: "text", text: "看看日志" })
  assert.deepEqual(parseCommand("3个文件"), { type: "text", text: "3个文件" })
  assert.deepEqual(parseCommand("目录"), { type: "dirs" })
  assert.deepEqual(parseCommand("目录 2"), { type: "cd", arg: "2" })
  assert.deepEqual(parseCommand("文件夹 马原"), { type: "cd", arg: "马原" })
  assert.deepEqual(parseCommand("新对话"), { type: "new", text: "" })
  assert.deepEqual(parseCommand("新对话 帮我看下 README"), { type: "new", text: "帮我看下 README" })
  assert.deepEqual(parseCommand("新对话的想法"), { type: "text", text: "新对话的想法" })
  assert.deepEqual(parseCommand("目录2"), { type: "cd", arg: "2" })
  assert.deepEqual(parseCommand("目录结构怎么整理"), { type: "text", text: "目录结构怎么整理" })
  assert.deepEqual(parseCommand("5 历史"), { type: "history", n: 5, count: 5 })
  assert.deepEqual(parseCommand("5 历史 10"), { type: "history", n: 5, count: 10 })
  for (const c of [1, 2, 3, 4]) assert.deepEqual(parseCommand(`5 历史 ${c}`), { type: "history", n: 5, count: c })
  assert.deepEqual(parseCommand("5 历史3"), { type: "history", n: 5, count: 3 })
  assert.deepEqual(parseCommand("历史"), { type: "history", count: 5 })
  assert.deepEqual(parseCommand("历史 30"), { type: "history", count: 20 })
  assert.deepEqual(parseCommand("历史 0"), { type: "history", count: 1 })
  assert.deepEqual(parseCommand("/history 3"), { type: "history", count: 3 })
  assert.deepEqual(parseCommand("历史文件夹里有什么"), { type: "text", text: "历史文件夹里有什么" })
  assert.deepEqual(parseCommand("5 历史记录在哪"), { type: "text", n: 5, text: "历史记录在哪" })
  assert.deepEqual(parseCommand("列表。"), { type: "list" })
  assert.deepEqual(parseCommand("帮助！"), { type: "help" })
  assert.deepEqual(parseCommand("help?"), { type: "help" })
  assert.deepEqual(parseCommand(" 目录 "), { type: "dirs" })
  assert.deepEqual(parseCommand("10 帮助"), { type: "help" })
  assert.deepEqual(parseCommand("10 列表"), { type: "list" })
  assert.deepEqual(parseCommand("10 目录"), { type: "dirs" })
  const multi = (...types) => ({ type: "multi", cmds: types.map((type) => ({ type })) })
  assert.deepEqual(parseCommand("帮助 列表"), multi("help", "list"))
  assert.deepEqual(parseCommand("列表 帮助"), multi("list", "help"))
  assert.deepEqual(parseCommand("帮助\n列表"), multi("help", "list"))
  assert.deepEqual(parseCommand("帮助，列表。"), multi("help", "list"))
  assert.deepEqual(parseCommand("目录 马原"), { type: "cd", arg: "马原" })
  assert.deepEqual(parseCommand("5 帮我列表一下文件"), { type: "text", n: 5, text: "帮我列表一下文件" })
  assert.deepEqual(parseCommand("列表里第二个是什么"), { type: "text", text: "列表里第二个是什么" })
  assert.deepEqual(parseCommand("3 y"), { type: "text", n: 3, text: "y" })
  assert.deepEqual(parseCommand("帮助 列表 看看日志"), { type: "text", text: "帮助 列表 看看日志" })
})

test("imagePaths", () => {
  const dir = "C:\\proj"
  assert.deepEqual(imagePaths("截图在 C:\\a\\b\\x.png。", dir), ["C:\\a\\b\\x.png"])
  assert.deepEqual(imagePaths("C:/a/y.JPG, done", dir), ["C:\\a\\y.JPG"])
  assert.deepEqual(imagePaths("截图在D:\\马原\\x.png", dir), ["D:\\马原\\x.png"])
  assert.deepEqual(imagePaths("见 file:///C:/a%20b/z.webp", dir), ["C:\\a b\\z.webp"])
  assert.deepEqual(imagePaths("![图](C:\\a\\m.gif) 和 [链接](<C:\\a b\\n.jpeg>)", dir), ["C:\\a\\m.gif", "C:\\a b\\n.jpeg"])
  assert.deepEqual(imagePaths("文件 `C:\\My Pics\\q.png` 好了", dir), ["C:\\My Pics\\q.png"])
  assert.deepEqual(imagePaths("生成了 out/chart.png 和 ./a.png", dir), ["C:\\proj\\out\\chart.png", "C:\\proj\\a.png"])
  assert.deepEqual(imagePaths("out/chart.png"), [])
  assert.deepEqual(imagePaths("https://x.com/a.png ![](http://x.com/b.png)", dir), [])
  assert.deepEqual(imagePaths("C:\\a\\notes.txt C:\\a\\pic.png.bak C:\\a\\x.svg", dir), [])
  assert.deepEqual(imagePaths("C:\\a\\x.png `C:\\a\\x.png` ![](C:/a/x.png)", dir), ["C:\\a\\x.png"])
  assert.deepEqual(imagePaths("1.png 2.png 3.png 4.png 5.png", dir).length, 4)
})

test("parseCommand image", () => {
  assert.deepEqual(parseCommand("图 C:\\a\\x.png"), { type: "image", path: "C:\\a\\x.png" })
  assert.deepEqual(parseCommand("/img `out/a b.png`"), { type: "image", path: "out/a b.png" })
  assert.deepEqual(parseCommand("图片好看吗"), { type: "text", text: "图片好看吗" })
  assert.deepEqual(parseCommand("图片怎么发"), { type: "text", text: "图片怎么发" })
  assert.deepEqual(parseCommand("图 好看吗"), { type: "text", text: "图 好看吗" })
  assert.deepEqual(parseCommand("图 C:\\a\\notes.txt"), { type: "text", text: "图 C:\\a\\notes.txt" })
})

test("historyLines", () => {
  const user = (text) => ({ type: "user", text })
  const ai = (...parts) => ({ type: "assistant", content: parts })
  const tool = (name) => ({ type: "tool", name })
  const txt = (text) => ({ type: "text", text })
  // Newest first, as the API returns with order=desc.
  const msgs = [
    ai(txt("改好了"), tool("read")),
    ai(tool("shell"), { type: "reasoning", text: "想" }),
    ai(tool("shell")),
    user("改一下"),
    { type: "idle" },
    ai({ type: "reasoning", text: "只有思考" }),
    ai(txt("你好")),
    user(" "),
    user("在吗"),
  ]
  assert.deepEqual(historyLines(msgs, 5, 10), [
    "[5] 你：在吗",
    "[5] AI：你好",
    "[5] 你：改一下",
    "[5] AI：改好了\n（调用了 shell ×2、read）",
    "[5] 以上是最近 4 条（只找到这么多）",
  ])
  assert.deepEqual(historyLines(msgs, 5, 2), ["[5] 你：改一下", "[5] AI：改好了\n（调用了 shell ×2、read）", "[5] 以上是最近 2 条"])
  assert.deepEqual(historyLines([], 5, 3), ["[5] 还没有消息"])
  const many = []
  for (let i = 9; i >= 0; i--) many.push({ type: "assistant", content: [{ type: "text", text: `答${i}` }] }, { type: "user", text: `问${i}` })
  for (const c of [1, 2, 3, 4]) assert.equal(historyLines(many, 5, c).length, c + 1)
  assert.deepEqual(historyLines(many, 5, 1), ["[5] AI：答9", "[5] 以上是最近 1 条"])
})

test("pickDir", () => {
  const dirs = ["C:\\a\\11", "C:\\a\\马原", "C:\\a\\PPT模板"]
  assert.equal(pickDir(dirs, "2"), "C:\\a\\马原")
  assert.equal(pickDir(dirs, "9"), undefined)
  assert.equal(pickDir(dirs, "ppt"), "C:\\a\\PPT模板")
  assert.equal(pickDir(dirs, "马原"), "C:\\a\\马原")
})

test("formAnswer", () => {
  const sel = { fields: [{ key: "db", type: "string", options: [{ value: "pg", label: "Postgres" }, { value: "my", label: "MySQL" }] }] }
  assert.deepEqual(formAnswer(sel, "2"), { db: "my" })
  assert.deepEqual(formAnswer(sel, "Postgres"), { db: "pg" })
  assert.deepEqual(formAnswer(sel, "随便"), { db: "随便" })
  assert.deepEqual(formAnswer({ fields: [{ key: "ok", type: "boolean" }] }, "是"), { ok: true })
  assert.equal(formAnswer({ fields: [{ key: "ok", type: "boolean" }] }, "也许"), null)
  assert.deepEqual(formAnswer({ fields: [{ key: "n", type: "integer" }] }, "5"), { n: 5 })
  assert.deepEqual(formAnswer({ fields: [{ key: "m", type: "multiselect", options: sel.fields[0].options }] }, "1，MySQL"), { m: ["pg", "my"] })
  assert.equal(formAnswer({ fields: [{ key: "a", type: "string" }, { key: "b", type: "string" }] }, "x"), null)
})

test("inboundText", () => {
  const msg = { message_type: 1, from_user_id: "me", item_list: [{ type: 1, text_item: { text: " 3 y " } }] }
  assert.equal(inboundText(msg, "me"), "3 y")
  assert.equal(inboundText(msg, "someone-else"), null)
  assert.equal(inboundText(msg, undefined), null)
  assert.equal(inboundText({ ...msg, message_type: 2 }, "me"), null)
  assert.equal(inboundText({ ...msg, group_id: "g1" }, "me"), null)
  assert.equal(inboundText({ ...msg, from_user_id: undefined }, undefined), null)
  assert.equal(inboundText({ ...msg, item_list: [{ type: 3, voice_item: { text: "列表" } }] }, "me"), "列表")
  assert.equal(inboundText({ ...msg, item_list: [{ type: 2 }] }, "me"), null)
})

test("eventKey", () => {
  // Two runs of the same session finishing within 5 s are different events and must both push.
  assert.notEqual(eventKey({ ...ok, id: "evt_1" }), eventKey({ ...ok, id: "evt_2" }))
  assert.equal(eventKey({ ...ok, id: "evt_1" }), "evt_1")
  assert.equal(eventKey({ type: "permission.asked", data: { id: "per_1", sessionID: "s1" } }), "s1:permission.asked:per_1")
})

test("sleep", async () => {
  const c = new AbortController()
  for (let i = 0; i < 5; i++) await sleep(1, c.signal)
  assert.equal(getEventListeners(c.signal, "abort").length, 0)
  const pending = sleep(60_000, c.signal)
  c.abort()
  assert.equal(await pending, undefined)
})

test("debounce", () => {
  assert.equal(shouldSend("k", 1000), true)
  assert.equal(shouldSend("k", 3000), false)
  assert.equal(shouldSend("k", 7000), true)
})
