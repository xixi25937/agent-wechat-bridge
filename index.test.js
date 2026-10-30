import assert from "node:assert/strict"
import { getEventListeners } from "node:events"
import crypto from "node:crypto"
import { test } from "node:test"
import {
  HELP, KEEP_MS, PAIR_MS, addText, addTool, aesKeyOf, chunkLines, clip, slashHelpText, codexPushText, dirLabel, dirsText, doneText, eventKey, extOf, format,
  historyLines, imagePaths, inboundMedia, inboundText, liveBody, liveCmd, liveDelay, liveMedia, listMessages, listText, lowestFree, liveOn, mediaAck, mergeLines,
  modelLines, withSkip, parseCommand, pickDir, prunable, pickModel, codexUnsendPlan, replyText, revertFiles, sessionIDOf, shouldSend, sleep, splitText, takeLive, unsendAsk,
  unsendPlan, withMedia, withPre,
} from "./index.js"
import { looseBreaks } from "./md.js"

const session = { id: "s1", title: "重构登录模块", location: { directory: "C:\\Users\\me\\22" } }
const ok = { type: "session.execution.succeeded", data: { sessionID: "s1" } }

// Every message the bridge composes must lay out under Markdown: paragraphs apart by a blank line, and a single "\n" only
// between "- " items (WeChat shows any other single "\n" as a space).
const flat = (...msgs) => msgs.flat().forEach((m) => assert.deepEqual(looseBreaks(m), [], `single \\n in: ${JSON.stringify(m)}`))

test("format", () => {
  const H = "[3] OpenCode · 22 / 重构登录模块"
  assert.equal(format(ok, session, 3, "改好了"), `${H}\n\n改好了`)
  assert.equal(format(ok, session, 3, ""), `${H}\n\n完成（没有文字回复）`)
  assert.equal(format(ok, session, 3, "第一段\n第二行\n\n- 列表\n- 列表二"), `${H}\n\n第一段\n第二行\n\n- 列表\n- 列表二`, "the agent's text goes through untouched")
  assert.equal(format(ok, { ...session, parentID: "p" }, 3, "x"), null)
  assert.equal(format({ ...ok, location: { directory: "/a/b" } }, undefined, 1, "x"), "[1] OpenCode · b / 未命名会话\n\nx")
  assert.equal(format(ok, undefined, 1, "x"), "[1] OpenCode / 未命名会话\n\nx", "no folder known: just the agent")
  const failed = format({ type: "session.execution.failed", data: { error: { type: "x", message: "rate\nlimited" } } }, session, 3)
  assert.equal(failed, `${H}\n\n出错：rate limited`)
  const asked = format({ type: "permission.asked", data: { action: "shell", resources: ["git push"] } }, session, 3)
  assert.equal(asked, `${H}\n\n等你批准：shell git push\n\n回复「3 y」批准一次，「3 n」拒绝`)
  // The one-line ending of a run whose progress was all pushed carries the tag, without the title.
  assert.equal(format(ok, session, 3, "x", { body: "", pushed: true }), "[3] OpenCode · 22 完成")
  const fields = [{ key: "db", type: "string", title: "选数据库", options: [{ value: "pg", label: "Postgres" }] }]
  const form = { type: "form.created", data: { form: { sessionID: "s1", title: "用哪个数据库？", fields } } }
  assert.equal(
    format(form, session, 3),
    `${H}\n\n有问题问你：用哪个数据库？\n\n选数据库（可跳过）\n\n- 1 Postgres\n\n回复「3 答案」（可以回编号）\n\n不想回答发「3 忽略」`,
  )
  flat(failed, asked, format(form, session, 3))
  assert.equal(sessionIDOf(form), "s1")
})

test("clip", () => {
  assert.equal(clip(" hi "), "hi")
  assert.equal(clip("x".repeat(8000)), "x".repeat(8000))
  assert.equal(clip("x".repeat(9000), 3), "x".repeat(8000) + "\n\n…（还有 1000 字，发「3 历史 1」或看桌面端）")
  assert.equal(clip("x".repeat(9000)).slice(8000), "\n\n…（还有 1000 字，看桌面端）")
})

test("splitText", () => {
  assert.deepEqual(splitText("[3] OpenCode · a / b\n\nhi"), ["[3] OpenCode · a / b\n\nhi"])
  // Paragraph breaks win, then line breaks; numbering goes on the header line (full tag) and, in a paragraph of its own,
  // after the short [N] on the rest.
  const para = "x".repeat(700)
  const parts = splitText(`[3] OpenCode · 22 / 标题\n\n${[para, para, para, para].join("\n\n")}`, 1800)
  assert.equal(parts.length, 2)
  assert.ok(parts[0].startsWith("[3] OpenCode · 22 / 标题 (1/2)\n\n"))
  assert.ok(parts[0].endsWith(para) && !parts[0].endsWith("\n"))
  assert.equal(parts[1], `[3] (2/2)\n\n${para}\n\n${para}`)
  flat(parts)
  const lines = Array.from({ length: 50 }, (_, i) => `第 ${i} 行 ${"y".repeat(60)}`).join("\n")
  const byLine = splitText(lines, 1000)
  assert.ok(byLine.length >= 4 && byLine.every((p) => p.length <= 1000 + 12))
  assert.equal(byLine.map((p, i) => p.replace(i ? /^\(\d+\/\d+\)\n\n/ : /^\(1\/\d+\)\n\n/, "")).join("\n"), lines, "nothing is lost")
  // No break at all: a hard cut that never splits an emoji's surrogate pair.
  const hard = splitText("a" + "😀".repeat(20), 10).map((p) => p.replace(/^\(\d+\/\d+\)\n\n/, ""))
  assert.equal(hard.join(""), "a" + "😀".repeat(20))
  assert.ok(hard.every((p) => !/[\ud800-\udbff]$/.test(p) && !/^[\udc00-\udfff]/.test(p)))
  // The longest push: a capped 8000-character reply is five chunks.
  assert.equal(splitText(`[3] h\n\n${clip("z".repeat(9000), 3)}`, 1800).length, 5)
  // A bullet list is cut between two items, and the next chunk opens with the numbering paragraph, then the list.
  const items = Array.from({ length: 40 }, (_, i) => `- 项目 ${i} ${"z".repeat(60)}`).join("\n")
  const listed = splitText(`[3] OpenCode · 22 / 标题\n\n${items}`, 1000)
  assert.ok(listed.length >= 3)
  listed.forEach((p, i) => {
    if (i) assert.match(p, new RegExp(`^\\[3\\] \\(${i + 1}/${listed.length}\\)\\n\\n- 项目 \\d+ z+(\\n- 项目 \\d+ z+)*$`))
    else assert.match(p, /^\[3\] OpenCode · 22 \/ 标题 \(1\/\d+\)\n\n- 项目 0 /)
  })
  assert.equal(listed.map((p, i) => p.replace(i ? /^\[3\] \(\d+\/\d+\)\n\n/ : /^.*\n\n/, "")).join("\n"), items, "no item is lost or cut")
  flat(listed)
  // Not before an indented line (a nested item would open the next chunk as a code block): the unindented break wins.
  const nested = Array.from({ length: 30 }, (_, i) => `- 项 ${i} ${"n".repeat(30)}\n    - 子项 ${i} ${"m".repeat(30)}`).join("\n")
  for (const p of splitText(`[3] h\n\n${nested}`, 800).slice(1)) assert.ok(/^\[3\] \(\d+\/\d+\)\n\n- 项 /.test(p), p.slice(0, 40))
})

test("replyText", () => {
  const a = (...texts) => ({ type: "assistant", content: texts.map((t) => (t ? { type: "text", text: t } : { type: "tool" })) })
  const user = { type: "user", text: "q" }
  assert.equal(replyText([a(null), a("最终", "回复"), user, a("旧的")]), "最终\n\n回复", "separate text parts are separate paragraphs")
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
  const sh = slashHelpText("[7] OpenCode · ttool", [{ name: "review", description: "review changes" }, { name: "init" }, { name: "x", description: "两行\n说明" }])
  assert.ok(sh.includes("当前对话 [7] OpenCode · ttool") && sh.includes("/model") && sh.includes("/stop") && sh.includes("/compact"))
  assert.ok(sh.includes("\n- /review → review changes\n- /init\n- /x → 两行 说明"), "the folder's commands are bullets")
  assert.ok(!slashHelpText(undefined).includes("自带命令"))
  flat(sh, slashHelpText(), HELP)
  assert.deepEqual(parseCommand("／"), { type: "help" })
  assert.deepEqual(parseCommand(" 3 "), { type: "show", n: 3 })
  assert.deepEqual(parseCommand("3 继续改\n第二行"), { type: "text", n: 3, text: "继续改\n第二行" })
  assert.deepEqual(parseCommand("3：y"), { type: "text", n: 3, text: "y" })
  assert.deepEqual(parseCommand("看看日志"), { type: "text", text: "看看日志" })
  assert.deepEqual(parseCommand("3个文件"), { type: "text", text: "3个文件" })
  assert.deepEqual(parseCommand("目录"), { type: "dirs" })
  assert.deepEqual(parseCommand("目录 2"), { type: "cd", arg: "2" })
  assert.deepEqual(parseCommand("文件夹 读书笔记"), { type: "cd", arg: "读书笔记" })
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
  assert.deepEqual(parseCommand("目录 读书笔记"), { type: "cd", arg: "读书笔记" })
  assert.deepEqual(parseCommand("5 帮我列表一下文件"), { type: "text", n: 5, text: "帮我列表一下文件" })
  assert.deepEqual(parseCommand("列表里第二个是什么"), { type: "text", text: "列表里第二个是什么" })
  assert.deepEqual(parseCommand("3 y"), { type: "text", n: 3, text: "y" })
  assert.deepEqual(parseCommand("帮助 列表 看看日志"), { type: "text", text: "帮助 列表 看看日志" })
})

test("帮助: titled sections of one-line bullets", () => {
  // [title, list, title, list, ...]
  const blocks = HELP.split("\n\n")
  // Width in Chinese characters: a phone line holds about 16, and these items must stay near one line.
  const em = (s) => [...s].reduce((w, c) => w + (c.charCodeAt(0) > 0x2000 ? 1 : c === " " ? 0.3 : 0.55), 0)
  assert.ok(blocks.length % 2 === 0)
  blocks.forEach((b, i) => {
    if (i % 2) assert.ok(b.split("\n").every((l) => l.startsWith("- ") && em(l.slice(2)) <= 18), b)
    else assert.match(b, /^【[^】]+】$/)
  })
  assert.deepEqual(blocks.filter((_, i) => i % 2 === 0).map((t) => t.slice(1, -1)), ["发消息", "看对话", "批准和回答", "文件夹和新对话", "图片", "文件", "撤回", "实时推送", "其他"])
  assert.ok(slashHelpText("[7] OpenCode", [{ name: "init" }]).split("\n").every((l) => !l.startsWith("- ") || em(l.slice(2)) <= 18))
  // Nothing Markdown could pick up: emphasis, headings, quotes, code.
  assert.ok(!/[*_`#>]/.test(HELP) && !/[*_`#>]/.test(slashHelpText("[7] OpenCode · ttool")))
  for (const c of ["列表", "目录", "新对话", "图 路径", "历史", "实时", "3 y / 3 n", "撤回", "/unsend", "文件 路径", "文件提示", "额度"]) assert.ok(HELP.includes(c), c)
})

test("imagePaths", () => {
  const dir = "C:\\proj"
  assert.deepEqual(imagePaths("截图在 C:\\a\\b\\x.png。", dir), ["C:\\a\\b\\x.png"])
  assert.deepEqual(imagePaths("C:/a/y.JPG, done", dir), ["C:\\a\\y.JPG"])
  assert.deepEqual(imagePaths("截图在D:\\读书笔记\\x.png", dir), ["D:\\读书笔记\\x.png"])
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
  // Without a tag: plain "[N]" everywhere. The label is a paragraph of its own; the body goes through untouched.
  assert.deepEqual(historyLines(msgs, 5, 10), [
    "[5] 你：\n\n在吗",
    "[5] AI：\n\n你好",
    "[5] 你：\n\n改一下",
    "[5] AI：\n\n改好了\n\n（调用了 shell ×2、read）",
    "[5] 以上是最近 4 条（只找到这么多）",
  ])
  // With one: the first message carries the full tag, the rest the short one.
  const full = "[5] OpenCode · ttool"
  const two = historyLines(msgs, 5, 2, full)
  assert.deepEqual(two, [`${full} 你：\n\n改一下`, "[5] AI：\n\n改好了\n\n（调用了 shell ×2、read）", "[5] 以上是最近 2 条"])
  flat(two)
  assert.deepEqual(historyLines([], 5, 3, full), [`${full} 还没有消息`])
  const many = []
  for (let i = 9; i >= 0; i--) many.push({ type: "assistant", content: [{ type: "text", text: `答${i}` }] }, { type: "user", text: `问${i}` })
  for (const c of [1, 2, 3, 4]) assert.equal(historyLines(many, 5, c).length, c + 1)
  assert.deepEqual(historyLines(many, 5, 1), ["[5] AI：\n\n答9", "[5] 以上是最近 1 条"])
  // A body that starts with a list or a heading is the agent's Markdown and stays as written.
  assert.deepEqual(historyLines([{ type: "assistant", content: [{ type: "text", text: "# 标题\n\n- 一\n- 二" }] }], 5, 1)[0], "[5] AI：\n\n# 标题\n\n- 一\n- 二")
})

test("pickDir", () => {
  const dirs = ["C:\\a\\11", "C:\\a\\读书笔记", "C:\\a\\PPT模板", "codex:C:\\b\\11", "codex:C:\\b\\proj"]
  assert.equal(pickDir(dirs, "2"), "C:\\a\\读书笔记")
  assert.equal(pickDir(dirs, "9"), undefined)
  assert.equal(pickDir(dirs, "ppt"), "C:\\a\\PPT模板")
  assert.equal(pickDir(dirs, "读书笔记"), "C:\\a\\读书笔记")
  assert.equal(pickDir(dirs, "4"), "codex:C:\\b\\11")
  assert.equal(pickDir(dirs, "Codex · 11"), "codex:C:\\b\\11")
  assert.equal(pickDir(dirs, "codex 11"), "codex:C:\\b\\11")
  assert.equal(pickDir(dirs, "proj"), "codex:C:\\b\\proj")
  assert.equal(pickDir(dirs, "codex 读书笔记"), undefined)
  assert.equal(dirLabel("codex:C:\\b\\proj"), "Codex · proj")
  assert.equal(dirLabel("C:\\a\\读书笔记"), "读书笔记")
})

test("codexPushText", () => {
  const h = "[4] Codex · proj / 修登录"
  assert.equal(codexPushText(h, 4, "done", "好的"), `${h}\n\n好的`)
  assert.equal(codexPushText(h, 4, "done", ""), `${h}\n\n完成（没有文字回复）`)
  assert.equal(codexPushText(h, 4, "failed", "rate\nlimited"), `${h}\n\n出错：rate limited`)
  const approval = codexPushText(h, 4, "approval", "git push")
  assert.match(approval, /^\[4\] Codex · proj \/ 修登录\n\n等你批准：git push\n\n回复「4 y」批准，「4 n」拒绝/)
  assert.equal(codexPushText(h, 4, "question", "有问题问你：x"), `${h}\n\n有问题问你：x`)
  flat(approval, codexPushText(h, 4, "failed", "x"))
})

test("mergeLines", () => {
  const rows = [{ updated: 1, line: "a" }, { updated: 3, line: "c" }, { line: "z" }, { updated: 2, line: "b" }]
  assert.deepEqual(mergeLines(rows), ["c", "b", "a", "z"])
  assert.deepEqual(mergeLines(rows, 2), ["c", "b"])
})

test("列表 and 目录 are bullet lists", () => {
  const list = listText([
    { updated: 1, line: "[2] Codex · proj / 修登录 · 空闲" },
    { updated: 3, line: "[1] OpenCode · ttool / 重构登录模块 · 运行中" },
  ])
  assert.equal(list, "- [1] OpenCode · ttool / 重构登录模块 · 运行中\n- [2] Codex · proj / 修登录 · 空闲")
  assert.equal(listText([]), "没有对话")
  // 「目录 X」: the listing sits between the line that names the folder and the hint.
  const cd = `已选中 ttool\n\n${list}\n\n回复「编号 内容」继续旧对话，「新对话 内容」开新对话`
  const dirs = dirsText(["C:\\a\\ttool", "C:\\a\\读书笔记", "codex:C:\\b\\proj"])
  assert.equal(dirs, "文件夹：\n\n- 1 ttool\n- 2 读书笔记\n- 3 Codex · proj\n\n回复「目录 编号」选择")
  assert.equal(dirsText([]), "没有文件夹")
  flat(list, cd, dirs)
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
  assert.equal(mediaAck([img("b.png")], "[3]"), "收到图片（共 1 张）\n\n接着发文字说明，会一起发给 [3]（不用说明就回「发」）")
  assert.equal(mediaAck(live, "[3]"), "收到图片和文件（共 1 张图片、1 个文件）\n\n接着发文字说明，会一起发给 [3]（不用说明就回「发」）")
  assert.match(mediaAck([img("b.png")], undefined), /用「编号 文字」指定/)
  assert.equal(mediaAck([], "[3]", 1), "有 1 个没收到（下载失败）")
  assert.match(mediaAck([img("b.png")], "[3]", 1), /^有 1 个没收到（下载失败）\n\n收到图片（共 1 张）/)
  flat(mediaAck(live, "[3]"), mediaAck([img("b.png")], "[3]", 1))
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
    "1 yapi/claude-sonnet-5-5",
    "2 yapi2/claude-sonnet-5-5 ← 当前",
    "3 deepseek/deepseek-v4-pro（不看图）",
  ])
  assert.deepEqual(chunkLines(["aaa", "bbb", "ccc"], 7), ["aaa\nbbb", "ccc"])
  assert.deepEqual(chunkLines(["a"]), ["a"])
  // The model list: header, bullets with visible numbers, footer; one message when it fits.
  const one = listMessages("[3] 可用模型（共 3 个）：", modelLines(ms, "yapi2/claude-sonnet-5-5"), "回复「/model 编号」切换")
  assert.deepEqual(one, [
    "[3] 可用模型（共 3 个）：\n\n- 1 yapi/claude-sonnet-5-5\n- 2 yapi2/claude-sonnet-5-5 ← 当前\n- 3 deepseek/deepseek-v4-pro（不看图）\n\n回复「/model 编号」切换",
  ])
  // Too long: the header leads the first message, the footer ends the last, and a split falls between two items.
  const long = Array.from({ length: 60 }, (_, i) => `${i + 1} provider/model-${"x".repeat(60)}-${i}`)
  const many = listMessages("头", long, "尾", 1800)
  assert.ok(many.length >= 3 && many.every((m) => m.length <= 1800))
  assert.ok(many[0].startsWith("头\n\n- 1 ") && many.at(-1).endsWith("\n\n尾") && !many.slice(0, -1).some((m) => m.includes("尾")))
  assert.ok(many.slice(1).every((m) => m.startsWith("- ")))
  assert.equal(many.join("\n").match(/^- /gm).length, 60, "no item is lost")
  flat(one, many)
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
  assert.equal(liveBody([" 第一步 ", "", "第二步"], tools), "第一步\n\n第二步\n\n（调用了 shell ×3、edit）")
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
  assert.deepEqual(takeLive("sL"), { body: "第一步\n\n第二步\n\n（调用了 shell ×2）", pushed: false })
  addText("sL", "完成", info)
  const end = takeLive("sL", true)
  assert.deepEqual(end, { body: "完成", pushed: true })
  assert.equal(doneText("[3] 22 / x", 3, "第一步\n第二步\n完成", end), "[3] 22 / x\n\n完成", "the final push only has what wasn't sent")
  assert.equal(doneText("[3] 22 / x", 3, "完成", { body: "", pushed: true }), "[3] 完成")
  assert.equal(doneText("[3] 22 / x", 3, "改好了", { body: "改好了", pushed: false }), "[3] 22 / x\n\n改好了", "a short run is one push, as before")
  assert.equal(doneText("[3] 22 / x", 3, "", { body: "", pushed: false }), "[3] 22 / x\n\n完成（没有文字回复）")
  assert.deepEqual(takeLive("sL"), { body: "", pushed: false }, "the run's entry is gone")
  // Progress off: nothing is kept for a run that pushed nothing; a run that did still gets its rest at the end.
  addText("sOff", "a", info)
  assert.deepEqual(takeLive("sOff", true, false), { body: "", pushed: false })
  addText("sOn", "a", info)
  takeLive("sOn")
  addText("sOn", "b", info)
  assert.deepEqual(takeLive("sOn", true, false), { body: "b", pushed: true })
  // Errors, approvals and questions carry pending progress after their header line.
  assert.equal(withPre("[3] 22 / x\n\n等你批准：git push", { body: "第二步" }), "[3] 22 / x\n\n第二步\n\n等你批准：git push")
  assert.equal(withPre("[3] 22 / x\n\n出错：x", { body: "" }), "[3] 22 / x\n\n出错：x")
  assert.equal(withPre("[3] h\n\n出错", { body: "花了 $& 和 $1" }), "[3] h\n\n花了 $& 和 $1\n\n出错", "the agent's text is never read as a replacement pattern")
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
  s.info = { a: { dir: "C:\\x\\ttool" } }
  assert.match(liveCmd(s, "a", 1, false), /^\[1\] OpenCode · ttool 的实时推送已关闭/)
  assert.equal(liveOn(s, "a"), false)
  assert.equal(liveOn(s, "b"), true)
  assert.match(liveCmd(s, "*", undefined), /^实时推送：开（\[1\] OpenCode · ttool 关）\n\n「实时 关」/)
  flat(liveCmd(s, "*", undefined))
  liveCmd(s, "*", undefined, false)
  assert.deepEqual(s.live, { "*": false }, "the global switch clears per-conversation ones")
  assert.equal(liveOn(s, "a"), false)
  liveCmd(s, "b", 2, true)
  assert.equal(liveOn(s, "b"), true)
  assert.equal(liveCmd(s, "b", 2), "[2] OpenCode 实时推送：开", "no folder cached: just the agent")
})

test("lowestFree hands out the lowest unused number", () => {
  assert.equal(lowestFree({}), 1, "empty state starts at 1")
  assert.equal(lowestFree({ a: 1, b: 2 }), 3)
  const nums = { a: 2, b: 4, c: 5 }
  const got = []
  for (const k of ["x", "y", "z", "w"]) got.push((nums[k] = lowestFree(nums)))
  assert.deepEqual(got, [1, 3, 6, 7], "gaps are filled in order")
  assert.deepEqual([nums.a, nums.b, nums.c], [2, 4, 5], "existing numbers stay")
  delete nums.x
  assert.equal(lowestFree(nums), 1, "a removed key frees its number")
})

test("prunable releases gone and unused conversations, never protected ones", () => {
  const H = 3_600_000
  const now = 1000 * H
  const s = {
    nums: { fresh: 1, old: 2, gone: 3, target: 4, last: 5, form: 6, busyOld: 7, busyGone: 8, noUsed: 9 },
    used: { fresh: now - 23 * H, old: now - 25 * H, gone: now, target: now - 99 * H, last: now - 99 * H, form: now - 99 * H, busyOld: now - 99 * H, busyGone: now - 99 * H },
    target: "target",
    last: "last",
    forms: { form: { answers: {} } },
  }
  const opts = { exists: (k) => k !== "gone" && k !== "busyGone", busy: (k) => k.startsWith("busy") }
  // old: 25 h unused. gone: used just now but deleted. Kept: fresh, noUsed (no entry = used now), target / last / form /
  // busyOld / busyGone (protected, even though old or gone).
  assert.deepEqual(prunable(s, now, opts), ["old", "gone"])
  assert.deepEqual(prunable(s, now), ["old", "busyOld", "busyGone"], "defaults: all exist and none is busy; target / last / form stay")
  assert.deepEqual(prunable({ nums: { a: 1, b: 2 }, used: { a: now - KEEP_MS, b: now - KEEP_MS + 1 } }, now), ["a"], "24 h is the limit")
  assert.deepEqual(prunable({ nums: { a: 1, b: 2 } }, now), [], "state from before `used` existed loses nothing")
  assert.deepEqual(prunable({}, now), [])
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
  assert.equal(unsendAsk(3, long, true), "[3] 将撤回「一二三四五六七八九十一二三四五六七八九十一二三四五六七八九…」及之后的 2 条回复（会先停止正在运行的回复）\n\n确认发「3 撤回 确认」（2 分钟内有效）")
  assert.equal(unsendAsk(3, { kind: "inbox", text: "排队中", replies: 0 }), "[3] 将撤回还在排队的「排队中」\n\n确认发「3 撤回 确认」（2 分钟内有效）")
  assert.equal(unsendAsk(3, { kind: "inbox", text: "排队中", replies: 0 }, false, "[3] Codex · proj"), "[3] Codex · proj 将撤回还在排队的「排队中」\n\n确认发「3 撤回 确认」（2 分钟内有效）", "the number to type stays plain")
  flat(unsendAsk(3, long, true))
  assert.equal(revertFiles({ files: [{ file: "C:\\x\\b.txt" }, { file: "keep.txt" }], snapshot: "s" }), "改过的 2 个文件也还原了：b.txt、keep.txt")
  assert.equal(revertFiles({ files: [], snapshot: "s" }), "这几轮没有改文件")
  assert.match(revertFiles({ files: [] }), /没有还原/)
})

test("debounce", () => {
  assert.equal(shouldSend("k", 1000), true)
  assert.equal(shouldSend("k", 3000), false)
  assert.equal(shouldSend("k", 7000), true)
})

test("额度 command and the other quota words", () => {
  assert.deepEqual(parseCommand("额度"), { type: "quota" })
  assert.deepEqual(parseCommand("/quota"), { type: "quota" })
  assert.deepEqual(parseCommand("/QUOTA"), { type: "quota" })
  assert.deepEqual(parseCommand(" 额度。"), { type: "quota" })
  assert.deepEqual(parseCommand("10 额度"), { type: "quota" })
  assert.deepEqual(parseCommand("帮助 额度"), { type: "multi", cmds: [{ type: "help" }, { type: "quota" }] })
  assert.deepEqual(parseCommand("/quota 5"), { type: "help" }, "a malformed own slash command shows help, never reaches the AI")
  assert.deepEqual(parseCommand("额度够不够用"), { type: "text", text: "额度够不够用" })
  assert.deepEqual(parseCommand("3 额度不够了"), { type: "text", n: 3, text: "额度不够了" })
  assert.ok(HELP.split("\n\n").at(-1).includes("额度 → "), "the 其他 section mentions it in one line")
})

test("live progress: the interval follows the allowance used", () => {
  assert.equal(liveDelay(1000, 1000, 0), 15_000)
  assert.equal(liveDelay(1000, 1000, 4), 15_000)
  assert.equal(liveDelay(1000, 1000, 5), 60_000)
  assert.equal(liveDelay(1000, 31_000, 5), 30_000)
  assert.equal(liveDelay(1000, 70_000, 9), 0)
})

test("progress left out near the end of the allowance: the final push is the reply plus one note", () => {
  const H = "[3] OpenCode · 22 / x"
  const live = { body: "", pushed: true, skipped: 2 }
  // Progress was pushed before, then two segments were dropped: the last reply comes back, not a bare 「完成」.
  assert.equal(doneText(H, 3, "改好了", live), `${H}\n\n改好了\n\n（有 2 段进度没推，看桌面端或「3 历史」）`)
  // Text gathered after the skips (the allowance came back) is what is sent.
  assert.equal(doneText(H, 3, "改好了", { ...live, body: "后来的" }), `${H}\n\n后来的\n\n（有 2 段进度没推，看桌面端或「3 历史」）`)
  assert.equal(doneText(H, 3, "", { body: "", pushed: false, skipped: 1 }), `${H}\n\n完成（没有文字回复）\n\n（有 1 段进度没推，看桌面端或「3 历史」）`)
  // Without skips nothing changes.
  assert.equal(doneText(H, 3, "改好了", { body: "", pushed: true }), "[3] 完成")
  // takeLive reports the count only when there is one, and keeps it across a non-final take (an approval).
  const info = async () => ({ head: H })
  addText("sSkip", "a", info)
  assert.deepEqual(takeLive("sSkip"), { body: "a", pushed: false })
  addText("sSkip", "b", info)
  const e = [...(globalThis.__wechatBridge.progress.entries())].find(([k]) => k === "sSkip")[1]
  e.skipped = 3
  e.texts = []
  assert.deepEqual(takeLive("sSkip"), { body: "", pushed: true, skipped: 3 })
  assert.deepEqual(takeLive("sSkip", true), { body: "", pushed: true, skipped: 3 })
  assert.equal(takeLive("sSkip").skipped, undefined, "the entry is gone after the end")
  // A failed run says it too; an ordinary message is untouched.
  assert.equal(withSkip(`${H}\n\n出错：x`, { skipped: 2 }, 3), `${H}\n\n出错：x\n\n（有 2 段进度没推，看桌面端或「3 历史」）`)
  assert.equal(withSkip("m", { body: "", pushed: true }, 3), "m")
  assert.match(format({ type: "session.execution.failed", data: { error: { message: "boom" } } }, session, 3, "", { skipped: 1 }), /出错：boom\n\n（有 1 段进度没推/)
  assert.equal(format({ type: "session.execution.failed", data: { error: { message: "boom" } } }, session, 3), "[3] OpenCode · 22 / 重构登录模块\n\n出错：boom")
})

test("default chunk size is 3500 and splitText follows it", () => {
  const one = "字".repeat(3400)
  assert.deepEqual(splitText(one), [one], "a message under the chunk size is one send")
  const parts = splitText(`[3] h\n\n${clip("z".repeat(9000), 3)}`)
  assert.equal(parts.length, 3, "a capped 8000-character reply is three sends, not five")
  assert.ok(parts.every((p) => p.length <= 3500 + 20))
})
