import assert from "node:assert/strict"
import { getEventListeners } from "node:events"
import crypto from "node:crypto"
import { test } from "node:test"
import {
  PAIR_MS, addText, addTool, aesKeyOf, chunkLines, clip, slashHelpText, codexPushText, dirLabel, doneText, eventKey, extOf, format, historyLines,
  imagePaths, inboundMedia, inboundText, liveBody, liveCmd, liveDelay, liveMedia, liveOn, mediaAck, mergeLines, modelLines, parseCommand, pickDir,
  pickModel, codexUnsendPlan, replyText, revertFiles, sessionIDOf, shouldSend, sleep, splitText, takeLive, unsendAsk, unsendPlan, withMedia, withPre,
} from "./index.js"

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
  assert.equal(
    format(form, session, 3),
    "[3] 22 / 重构登录模块\n有问题问你：用哪个数据库？\n选数据库（可跳过）\n  1. Postgres\n回复「3 答案」（可以回编号）\n不想回答发「3 忽略」",
  )
  assert.equal(sessionIDOf(form), "s1")
})

test("clip", () => {
  assert.equal(clip(" hi "), "hi")
  assert.equal(clip("x".repeat(8000)), "x".repeat(8000))
  assert.equal(clip("x".repeat(9000), 3), "x".repeat(8000) + "\n…（还有 1000 字，发「3 历史 1」或看桌面端）")
  assert.equal(clip("x".repeat(9000)).slice(8000), "\n…（还有 1000 字，看桌面端）")
})

test("splitText", () => {
  assert.deepEqual(splitText("[3] a / b\nhi"), ["[3] a / b\nhi"])
  // Paragraph breaks win, then line breaks; numbering goes on the header line and after the [N] tag.
  const para = "x".repeat(700)
  const parts = splitText(`[3] 22 / 标题\n${[para, para, para, para].join("\n\n")}`, 1800)
  assert.equal(parts.length, 2)
  assert.ok(parts[0].startsWith("[3] 22 / 标题 (1/2)\n"))
  assert.ok(parts[0].endsWith(para) && !parts[0].endsWith("\n"))
  assert.equal(parts[1], `[3] (2/2)\n${para}\n\n${para}`)
  const lines = Array.from({ length: 50 }, (_, i) => `第 ${i} 行 ${"y".repeat(60)}`).join("\n")
  const byLine = splitText(lines, 1000)
  assert.ok(byLine.length >= 4 && byLine.every((p) => p.length <= 1000 + 12))
  assert.equal(byLine.map((p, i) => p.replace(i ? /^\(\d+\/\d+\)\n/ : / \(1\/\d+\)$/m, "")).join("\n"), lines, "nothing is lost")
  // No break at all: a hard cut that never splits an emoji's surrogate pair.
  const hard = splitText("a" + "😀".repeat(20), 10).map((p, i) => p.replace(i ? /^\(\d+\/\d+\)\n/ : / \(1\/\d+\)$/, ""))
  assert.equal(hard.join(""), "a" + "😀".repeat(20))
  assert.ok(hard.every((p) => !/[\ud800-\udbff]$/.test(p) && !/^[\udc00-\udfff]/.test(p)))
  // The longest push: a capped 8000-character reply is five chunks.
  assert.equal(splitText(`[3] h\n${clip("z".repeat(9000), 3)}`).length, 5)
})

test("replyText", () => {
  const a = (...texts) => ({ type: "assistant", content: texts.map((t) => (t ? { type: "text", text: t } : { type: "tool" })) })
  const user = { type: "user", text: "q" }
  assert.equal(replyText([a(null), a("最终", "回复"), user, a("旧的")]), "最终\n回复")
  assert.equal(replyText([a(null), user, a("旧的")]), "")
  assert.equal(replyText([a(null), user, a("旧的")], false), "旧的")
  assert.equal(replyText([{ type: "idle" }, { type: "compaction" }, a("旧的")]), "")
  assert.equal(replyText([{ type: "assistant", content: [{ type: "reasoning", text: "想" }] }]), "")
})

test("parseCommand", () => {
  assert.deepEqual(parseCommand("列表"), { type: "list" })
  assert.deepEqual(parseCommand("/list"), { type: "list" })
  assert.deepEqual(parseCommand("帮助"), { type: "help" })
  assert.deepEqual(parseCommand("/"), { type: "help" })
  const sh = slashHelpText(7, [{ name: "review", description: "review changes" }, { name: "init" }])
  assert.ok(sh.includes("当前对话 [7]") && sh.includes("/model") && sh.includes("/stop") && sh.includes("/compact"))
  assert.ok(sh.includes("/review → review changes") && sh.includes("\n/init"))
  assert.ok(!slashHelpText(undefined).includes("自带命令"))
  assert.deepEqual(parseCommand("／"), { type: "help" })
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
  const dirs = ["C:\\a\\11", "C:\\a\\马原", "C:\\a\\PPT模板", "codex:C:\\b\\11", "codex:C:\\b\\proj"]
  assert.equal(pickDir(dirs, "2"), "C:\\a\\马原")
  assert.equal(pickDir(dirs, "9"), undefined)
  assert.equal(pickDir(dirs, "ppt"), "C:\\a\\PPT模板")
  assert.equal(pickDir(dirs, "马原"), "C:\\a\\马原")
  assert.equal(pickDir(dirs, "4"), "codex:C:\\b\\11")
  assert.equal(pickDir(dirs, "Codex · 11"), "codex:C:\\b\\11")
  assert.equal(pickDir(dirs, "codex 11"), "codex:C:\\b\\11")
  assert.equal(pickDir(dirs, "proj"), "codex:C:\\b\\proj")
  assert.equal(pickDir(dirs, "codex 马原"), undefined)
  assert.equal(dirLabel("codex:C:\\b\\proj"), "Codex · proj")
  assert.equal(dirLabel("C:\\a\\马原"), "马原")
})

test("codexPushText", () => {
  const h = "[4] Codex · proj / 修登录"
  assert.equal(codexPushText(h, 4, "done", "好的"), `${h}\n好的`)
  assert.equal(codexPushText(h, 4, "done", ""), `${h}\n完成（没有文字回复）`)
  assert.equal(codexPushText(h, 4, "failed", "rate\nlimited"), `${h}\n出错：rate limited`)
  assert.match(codexPushText(h, 4, "approval", "git push"), /^\[4\] Codex · proj \/ 修登录\n等你批准：git push\n回复「4 y」批准，「4 n」拒绝/)
  assert.equal(codexPushText(h, 4, "question", "有问题问你：x"), `${h}\n有问题问你：x`)
})

test("mergeLines", () => {
  const rows = [{ updated: 1, line: "a" }, { updated: 3, line: "c" }, { line: "z" }, { updated: 2, line: "b" }]
  assert.deepEqual(mergeLines(rows), ["c", "b", "a", "z"])
  assert.deepEqual(mergeLines(rows, 2), ["c", "b"])
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

test("parseCommand slash", () => {
  assert.deepEqual(parseCommand("/model"), { type: "slash", name: "model", args: "" })
  assert.deepEqual(parseCommand("/model 3"), { type: "slash", name: "model", args: "3" })
  assert.deepEqual(parseCommand("/Model claude sonnet"), { type: "slash", name: "Model", args: "claude sonnet" })
  assert.deepEqual(parseCommand("5 /stop"), { type: "slash", n: 5, name: "stop", args: "" })
  assert.deepEqual(parseCommand("5：/compact"), { type: "slash", n: 5, name: "compact", args: "" })
  assert.deepEqual(parseCommand("/review 看下\n改动"), { type: "slash", name: "review", args: "看下\n改动" })
  assert.deepEqual(parseCommand("/exa:web_search_help"), { type: "slash", name: "exa:web_search_help", args: "" })
  // The plugin's own commands still win.
  assert.deepEqual(parseCommand("/list"), { type: "list" })
  assert.deepEqual(parseCommand("/ls"), { type: "list" })
  assert.deepEqual(parseCommand("/help"), { type: "help" })
  assert.deepEqual(parseCommand("/dirs"), { type: "dirs" })
  assert.deepEqual(parseCommand("/cd 2"), { type: "cd", arg: "2" })
  assert.deepEqual(parseCommand("/new 你好"), { type: "new", text: "你好" })
  assert.deepEqual(parseCommand("/history 3"), { type: "history", count: 3 })
  assert.deepEqual(parseCommand("/img a.png"), { type: "image", path: "a.png" })
  // Malformed own commands show help instead of reaching the AI.
  assert.deepEqual(parseCommand("/img 好看吗"), { type: "help" })
  assert.deepEqual(parseCommand("/history abc"), { type: "help" })
  assert.deepEqual(parseCommand("/cd"), { type: "dirs" })
  // Ordinary text is unaffected.
  assert.deepEqual(parseCommand("/usr/bin 是什么"), { type: "text", text: "/usr/bin 是什么" })
  assert.deepEqual(parseCommand("3 /usr/local 下有什么"), { type: "text", n: 3, text: "/usr/local 下有什么" })
  assert.deepEqual(parseCommand("看看 /model 的用法"), { type: "text", text: "看看 /model 的用法" })
  assert.deepEqual(parseCommand("3 图"), { type: "text", n: 3, text: "图" })
  assert.deepEqual(parseCommand("发"), { type: "text", text: "发" })
})

test("inboundMedia", () => {
  const msg = (...items) => ({ message_type: 1, from_user_id: "me", item_list: items })
  const media = { encrypt_query_param: "p" }
  assert.deepEqual(inboundMedia(msg({ type: 2, image_item: { media: { ...media, aes_key: "k" }, mid_size: 99 } }), "me"), [
    { kind: "image", media: { ...media, aes_key: "k" }, key: "k", name: "", size: 99 },
  ])
  assert.deepEqual(inboundMedia(msg({ type: 2, image_item: { media, aeskey: "hex" } }), "me")[0].key, "hex")
  assert.deepEqual(inboundMedia(msg({ type: 4, file_item: { media: { ...media, aes_key: "k" }, file_name: " a.pdf ", len: "12" } }), "me"), [
    { kind: "file", media: { ...media, aes_key: "k" }, key: "k", name: "a.pdf", size: 12 },
  ])
  assert.deepEqual(inboundMedia(msg({ type: 1, text_item: { text: "x" } }, { type: 5, video_item: {} }), "me"), [])
  assert.deepEqual(inboundMedia(msg({ type: 2, image_item: { media } }), "other"), [])
  assert.deepEqual(inboundMedia({ ...msg({ type: 2, image_item: { media } }), message_type: 2 }, "me"), [])
})

test("aesKeyOf", () => {
  const key = crypto.randomBytes(16)
  const hex = key.toString("hex")
  assert.deepEqual(aesKeyOf(hex), key)
  assert.deepEqual(aesKeyOf(hex.toUpperCase()), key)
  assert.deepEqual(aesKeyOf(key.toString("base64")), key)
  // What sendImage puts in aes_key: base64 of the hex string.
  assert.deepEqual(aesKeyOf(Buffer.from(hex).toString("base64")), key)
  assert.deepEqual(aesKeyOf(` ${hex} `), key)
  assert.throws(() => aesKeyOf("short"), /密钥/)
  assert.throws(() => aesKeyOf(""), /密钥/)
})

test("extOf", () => {
  const b = (...parts) => Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p))))
  assert.equal(extOf(b([0x89], "PNG\r\n\x1a\n")), "png")
  assert.equal(extOf(b([0xff, 0xd8, 0xff, 0xe0])), "jpg")
  assert.equal(extOf(b("GIF89a")), "gif")
  assert.equal(extOf(b("RIFF", [1, 2, 3, 4], "WEBPVP8 ")), "webp")
  assert.equal(extOf(b([0, 0, 0, 0x18], "ftypheic")), "heic")
  assert.equal(extOf(b("%PDF-1.7")), "pdf")
  assert.equal(extOf(b("PK\x03\x04")), "zip")
  assert.equal(extOf(b("hello world")), null)
  assert.equal(extOf(Buffer.alloc(0)), null)
})

test("image pairing", () => {
  const now = 1_000_000
  const img = (p, at = now) => ({ kind: "image", path: p, at })
  const items = [img("a.png", now - PAIR_MS - 1), img("b.png", now - 1000), { kind: "file", path: "C:\\x\\r.pdf", at: now }]
  const live = liveMedia(items, now)
  assert.deepEqual(live.map((i) => i.path), ["b.png", "C:\\x\\r.pdf"], "expired media is dropped")
  assert.deepEqual(liveMedia(undefined, now), [])
  assert.deepEqual(withMedia("这是什么", [img("b.png")]), { text: "这是什么", images: ["b.png"] })
  assert.deepEqual(withMedia("发", [img("b.png")]), { text: "请看图片", images: ["b.png"] })
  assert.deepEqual(withMedia("Send", [img("b.png")]), { text: "请看图片", images: ["b.png"] })
  assert.deepEqual(withMedia("图", [img("b.png"), img("c.png")]), { text: "请看图片", images: ["b.png", "c.png"] })
  assert.deepEqual(withMedia("看下", live), { text: "看下\n\n微信发来的文件已保存在：\nC:\\x\\r.pdf", images: ["b.png"] })
  assert.deepEqual(withMedia("发", [live[1]]), { text: "请看文件\n\n微信发来的文件已保存在：\nC:\\x\\r.pdf", images: [] })
  assert.deepEqual(withMedia("发", []), { text: "发", images: [] })
  assert.equal(mediaAck([img("b.png")], "[3]"), "收到图片（共 1 张），接着发文字说明，会一起发给 [3]（不用说明就回「发」）")
  assert.equal(mediaAck(live, "[3]"), "收到图片和文件（共 1 张图片、1 个文件），接着发文字说明，会一起发给 [3]（不用说明就回「发」）")
  assert.match(mediaAck([img("b.png")], undefined), /用「编号 文字」指定/)
  assert.equal(mediaAck([], "[3]", 1), "有 1 个没收到（下载失败）")
  assert.match(mediaAck([img("b.png")], "[3]", 1), /^有 1 个没收到（下载失败）；收到图片（共 1 张）/)
})

test("pickModel / modelLines / chunkLines", () => {
  const ms = [
    { id: "claude-sonnet-5-5", label: "yapi/claude-sonnet-5-5", name: "Sonnet", image: true },
    { id: "claude-sonnet-5-5", label: "yapi2/claude-sonnet-5-5", name: "Sonnet", image: true },
    { id: "deepseek-v4-pro", label: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", image: false },
  ]
  assert.deepEqual(pickModel(ms, "3"), [ms[2]])
  assert.deepEqual(pickModel(ms, "9"), [])
  assert.deepEqual(pickModel(ms, "yapi2/claude-sonnet-5-5"), [ms[1]])
  assert.deepEqual(pickModel(ms, "claude-sonnet-5-5"), [ms[0], ms[1]], "same id on two providers is ambiguous")
  assert.deepEqual(pickModel(ms, "V4 PRO"), [ms[2]])
  assert.deepEqual(pickModel(ms, "gpt"), [])
  assert.deepEqual(modelLines(ms, "yapi2/claude-sonnet-5-5"), [
    "1. yapi/claude-sonnet-5-5",
    "2. yapi2/claude-sonnet-5-5 ← 当前",
    "3. deepseek/deepseek-v4-pro（不看图）",
  ])
  assert.deepEqual(chunkLines(["aaa", "bbb", "ccc"], 7), ["aaa\nbbb", "ccc"])
  assert.deepEqual(chunkLines(["a"]), ["a"])
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

test("live progress: batching, final push without repeats", () => {
  const info = async () => ({ head: "[3] 22 / x" })
  const tools = new Map([["shell", 3], ["edit", 1]])
  assert.equal(liveBody([" 第一步 ", "", "第二步"], tools), "第一步\n\n第二步\n（调用了 shell ×3、edit）")
  assert.equal(liveBody([], tools), "", "a tool summary alone waits for text")
  assert.equal(liveDelay(1000, 1000), 15_000)
  assert.equal(liveDelay(1000, 10_000), 6000)
  assert.equal(liveDelay(1000, 30_000), 0)
  // Ten plugin instances get the same event; only the first one records the segment.
  const ev = { id: "evt_live_1", type: "session.text.ended", data: { sessionID: "sL", text: "第一步" } }
  for (let i = 0; i < 10; i++) if (shouldSend(eventKey(ev))) addText("sL", ev.data.text, info)
  addTool("sL", "shell", info)
  addText("sL", "  ", info)
  addText("sL", "第二步", info)
  addTool("sL", "shell", info)
  // Two segments within the window go out as one push.
  assert.deepEqual(takeLive("sL"), { body: "第一步\n\n第二步\n（调用了 shell ×2）", pushed: false })
  addText("sL", "完成", info)
  const end = takeLive("sL", true)
  assert.deepEqual(end, { body: "完成", pushed: true })
  assert.equal(doneText("[3] 22 / x", 3, "第一步\n第二步\n完成", end), "[3] 22 / x\n完成", "the final push only has what wasn't sent")
  assert.equal(doneText("[3] 22 / x", 3, "完成", { body: "", pushed: true }), "[3] 完成")
  assert.equal(doneText("[3] 22 / x", 3, "改好了", { body: "改好了", pushed: false }), "[3] 22 / x\n改好了", "a short run is one push, as before")
  assert.equal(doneText("[3] 22 / x", 3, "", { body: "", pushed: false }), "[3] 22 / x\n完成（没有文字回复）")
  assert.deepEqual(takeLive("sL"), { body: "", pushed: false }, "the run's entry is gone")
  // Progress off: nothing is kept for a run that pushed nothing; a run that did still gets its rest at the end.
  addText("sOff", "a", info)
  assert.deepEqual(takeLive("sOff", true, false), { body: "", pushed: false })
  addText("sOn", "a", info)
  takeLive("sOn")
  addText("sOn", "b", info)
  assert.deepEqual(takeLive("sOn", true, false), { body: "b", pushed: true })
  // Errors, approvals and questions carry pending progress after their header line.
  assert.equal(withPre("[3] 22 / x\n等你批准：git push", { body: "第二步" }), "[3] 22 / x\n第二步\n\n等你批准：git push")
  assert.equal(withPre("[3] 22 / x\n出错：x", { body: "" }), "[3] 22 / x\n出错：x")
})

test("实时 command", () => {
  assert.deepEqual(parseCommand("实时 关"), { type: "live", on: false })
  assert.deepEqual(parseCommand("实时开"), { type: "live", on: true })
  assert.deepEqual(parseCommand("/live off"), { type: "live", on: false })
  assert.deepEqual(parseCommand("/LIVE on"), { type: "live", on: true })
  assert.deepEqual(parseCommand("5 实时 关"), { type: "live", n: 5, on: false })
  assert.deepEqual(parseCommand("5 /live on"), { type: "live", n: 5, on: true })
  assert.deepEqual(parseCommand("实时"), { type: "live" })
  assert.deepEqual(parseCommand("/live"), { type: "live" })
  assert.deepEqual(parseCommand("/live maybe"), { type: "help" })
  assert.deepEqual(parseCommand("实时更新一下文档"), { type: "text", text: "实时更新一下文档" })
  assert.deepEqual(parseCommand("5 实时关掉了吗"), { type: "text", n: 5, text: "实时关掉了吗" })
  const s = { nums: { a: 1, b: 2 } }
  assert.equal(liveOn(s, "a"), true, "on by default")
  assert.match(liveCmd(s, "a", 1, false), /\[1\] 的实时推送已关闭/)
  assert.equal(liveOn(s, "a"), false)
  assert.equal(liveOn(s, "b"), true)
  assert.match(liveCmd(s, "*", undefined), /^实时推送：开（\[1\] 关）/)
  liveCmd(s, "*", undefined, false)
  assert.deepEqual(s.live, { "*": false }, "the global switch clears per-conversation ones")
  assert.equal(liveOn(s, "a"), false)
  liveCmd(s, "b", 2, true)
  assert.equal(liveOn(s, "b"), true)
  assert.equal(liveCmd(s, "b", 2), "[2] 实时推送：开")
})

test("撤回 command and plan", () => {
  assert.deepEqual(parseCommand("撤回"), { type: "unsend" })
  assert.deepEqual(parseCommand("3 撤回"), { type: "unsend", n: 3 })
  assert.deepEqual(parseCommand("撤回 3"), { type: "unsend", n: 3 })
  assert.deepEqual(parseCommand("/unsend 3"), { type: "unsend", n: 3 })
  assert.deepEqual(parseCommand("3 /unsend"), { type: "unsend", n: 3 })
  assert.deepEqual(parseCommand("3 撤回 确认"), { type: "unsend", n: 3, confirm: true })
  assert.deepEqual(parseCommand("撤回 3 确认"), { type: "unsend", n: 3, confirm: true })
  assert.deepEqual(parseCommand("撤回确认"), { type: "unsend", confirm: true })
  assert.deepEqual(parseCommand("/unsend 3 confirm"), { type: "unsend", n: 3, confirm: true })
  assert.deepEqual(parseCommand("/unsend abc"), { type: "help" })
  assert.deepEqual(parseCommand("撤回上一步的修改"), { type: "text", text: "撤回上一步的修改" })
  assert.deepEqual(parseCommand("3 撤回刚才的提交"), { type: "text", n: 3, text: "撤回刚才的提交" })
  assert.equal(parseCommand("3 撤回 4").type, "text", "two numbers is not a command")
  const a = (t) => ({ type: "assistant", content: t ? [{ type: "text", text: t }] : [{ type: "tool", name: "shell" }] })
  const msgs = [a("好"), a(""), a("先看看"), { type: "user", id: "msg_2", text: "改一下" }, a("旧"), { type: "user", id: "msg_1", text: "旧问题" }]
  assert.deepEqual(unsendPlan(msgs, []), { kind: "revert", id: "msg_2", text: "改一下", replies: 2 })
  const inbox = [{ type: "compaction", id: "x" }, { type: "user", id: "msg_3", payload: { text: "排队中" } }, { type: "synthetic", id: "y" }]
  assert.deepEqual(unsendPlan(msgs, inbox), { kind: "inbox", id: "msg_3", text: "排队中", replies: 0 }, "a queued message goes first")
  assert.equal(unsendPlan([a("hi")], []), null)
  const turns = [
    { id: "t3", items: [{ type: "agentMessage", text: "压缩完了" }] },
    { id: "t2", items: [{ type: "userMessage", content: [{ type: "text", text: "跑测试" }] }, { type: "commandExecution" }, { type: "agentMessage", text: "过了" }] },
    { id: "t1", items: [{ type: "userMessage", content: [{ type: "text", text: "旧" }] }] },
  ]
  assert.deepEqual(codexUnsendPlan(turns), { kind: "codex", id: "t2", text: "跑测试", replies: 2 })
  assert.equal(codexUnsendPlan([]), null)
  const long = { kind: "revert", text: "一二三四五六七八九十".repeat(4), replies: 2 }
  assert.equal(unsendAsk(3, long, true), "[3] 将撤回「一二三四五六七八九十一二三四五六七八九十一二三四五六七八九…」及之后的 2 条回复（会先停止正在运行的回复），确认发「3 撤回 确认」（2 分钟内有效）")
  assert.equal(unsendAsk(3, { kind: "inbox", text: "排队中", replies: 0 }), "[3] 将撤回还在排队的「排队中」，确认发「3 撤回 确认」（2 分钟内有效）")
  assert.equal(revertFiles({ files: [{ file: "C:\\x\\b.txt" }, { file: "keep.txt" }], snapshot: "s" }), "改过的 2 个文件也还原了：b.txt、keep.txt")
  assert.equal(revertFiles({ files: [], snapshot: "s" }), "这几轮没有改文件")
  assert.match(revertFiles({ files: [] }), /没有还原/)
})

test("debounce", () => {
  assert.equal(shouldSend("k", 1000), true)
  assert.equal(shouldSend("k", 3000), false)
  assert.equal(shouldSend("k", 7000), true)
})
