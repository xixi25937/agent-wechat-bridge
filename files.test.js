import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"

import { agent, fakeHistory, sqlite, user } from "./fake-history.js"
import { looseBreaks } from "./md.js"

// A fake iLink + CDN on localhost, and a state folder of our own: nothing here reaches WeChat or ~/.cli-bridge.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wx-files-"))
const home = path.join(tmp, "state")
const proj = path.join(tmp, "proj")
fs.mkdirSync(home)
fs.mkdirSync(proj)

const log = []
const server = http.createServer((req, res) => {
  const chunks = []
  req.on("data", (c) => chunks.push(c))
  req.on("end", () => {
    const u = new URL(req.url, "http://x")
    const body = Buffer.concat(chunks)
    log.push({ path: u.pathname, query: u.searchParams, body, headers: req.headers })
    if (u.pathname === "/ilink/bot/getuploadurl") return res.end(JSON.stringify({ ret: 0, upload_param: `UP${log.length}` }))
    if (u.pathname === "/c2c/upload") return (res.setHeader("x-encrypted-param", `DL${log.length}`), res.end("{}"))
    if (u.pathname === "/ilink/bot/sendmessage") return res.end(JSON.stringify({ ret: 0 }))
    res.statusCode = 404
    res.end()
  })
})
await new Promise((r) => server.listen(0, "127.0.0.1", r))
const port = server.address().port
after(() => (server.closeAllConnections(), server.close(), fs.rmSync(tmp, { recursive: true, force: true })))

process.env.WECHAT_NOTIFY_DIR = home
process.env.WECHAT_NOTIFY_CDN = `http://127.0.0.1:${port}/c2c`
process.env.OPENCODE_SERVICE_FILE = path.join(tmp, "no-service.json")
process.env.CODEX_HOME = path.join(tmp, "codex")
fs.writeFileSync(path.join(home, "account.json"), JSON.stringify({ token: "tok", baseUrl: `http://127.0.0.1:${port}`, userId: "u1" }))

const ix = await import("./index.js")
const fl = await import("./files.js")
const { onStop } = await import("./codex-hook.js")
const { createBridge } = await import("./codex.js")

const calls = (p) => log.filter((c) => c.path === p)
const json = (c) => JSON.parse(c.body.toString())
const sent = () => calls("/ilink/bot/sendmessage").map((c) => json(c).msg.item_list[0])
const stateFile = path.join(home, "opencode-wechat-notify.json")
const setState = (o) => fs.writeFileSync(stateFile, JSON.stringify(o))
const getState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"))
const write = (rel, size = 10) => {
  const f = path.join(proj, rel)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, Buffer.alloc(size, "x"))
  return f
}
const flat = (...msgs) => msgs.flat().forEach((m) => assert.deepEqual(looseBreaks(m), [], `single \\n in: ${JSON.stringify(m)}`))

test("isSecret: credentials, .git, node_modules and the bridge's own folder", () => {
  const bridge = [home]
  for (const p of [".env", ".env.local", "a/b/.ENV", "server.key", "cert.PEM", "id_rsa", "id_rsa.pub", "id_ed25519", "auth.json", "account.json", "x/.git/config", "x/node_modules/p/index.js", "x/.ssh/known_hosts"])
    assert.ok(fl.isSecret(path.join(proj, p), bridge), p)
  assert.ok(fl.isSecret(path.join(home, "opencode-wechat-notify.json"), bridge), "state folder")
  assert.ok(fl.isSecret(path.join(os.homedir(), ".cli-bridge", "poll.lock")), "default bridge folder")
  for (const p of ["report.pdf", "a.py", "environment.md", "monkey.txt", "keys.txt", "auth.jsonl", "sub/gitignore.txt", "src/node_modules_notes.md"])
    assert.ok(!fl.isSecret(path.join(proj, p), bridge), p)
  assert.ok(!fl.isSecret(path.join(tmp, "state-other", "a.txt"), bridge), "a folder that only shares the prefix")
})

test("candidates: reply mentions first, then changed files; filtered, deduped, capped", () => {
  const report = write("report.pdf", 1234)
  const a = write("a.py")
  const subA = write("sub/a.py")
  const b = write("b.txt")
  write("chart.png")
  write(".env")
  write("server.key")
  write("node_modules/pkg/index.js")
  write(".git/config")
  write("empty.txt", 0)
  fs.mkdirSync(path.join(proj, "docs.d"))
  fs.writeFileSync(path.join(home, "mentioned.json"), "{}")
  const reply = `写好了 report.pdf，脚本在 \`${subA}\`，图在 chart.png，密钥 .env，缺的 missing.zip，链接 https://x.com/f.pdf，状态 ${path.join(home, "mentioned.json")}，版本 v1.2，还有 report.pdf`
  const edited = [a, subA, path.join("sub", "a.py"), path.join(proj, "node_modules/pkg/index.js"), path.join(proj, ".git/config"), b, "docs.d", "empty.txt", "a.py"]
  if (process.platform === "win32") edited.push(a.toUpperCase())
  const r = fl.candidates({ reply, dir: proj, edited, bridgeDirs: [home] })
  assert.deepEqual(r.files.map((f) => f.path), [report, subA, a, b])
  assert.deepEqual(r.files.map((f) => f.size), [1234, 10, 10, 10])
  assert.equal(r.more, 0)
  // Relative edited paths need the folder; without one only absolute ones count.
  assert.deepEqual(fl.candidates({ edited: ["a.py", a] }).files.map((f) => f.path), [a])
  // Size limit.
  assert.deepEqual(fl.candidates({ dir: proj, edited: [report, a], limit: 100 }).files.map((f) => f.path), [a])
  // Cap: ten shown, the rest counted.
  const many = Array.from({ length: 13 }, (_, i) => write(`many/t${String(i).padStart(2, "0")}.txt`))
  const capped = fl.candidates({ dir: proj, edited: many })
  assert.equal(capped.files.length, 10)
  assert.equal(capped.more, 3)
  assert.equal(capped.files[9].path, many[9])
  assert.deepEqual(fl.candidates({ dir: proj, edited: many, max: 2 }).more, 11)
  assert.deepEqual(fl.candidates({ reply: "nothing here", dir: proj }), { files: [], more: 0 })
})

test("mentionedPaths: any extension, same forms as images", () => {
  const ok = (r) => /\.[a-z0-9]{1,10}$/i.test(r)
  const D = path.join(tmp, "d")
  assert.deepEqual(fl.mentionedPaths("见 out/r.pdf 和 ./a.py。", D, ok, 10), [path.join(D, "out/r.pdf"), path.join(D, "a.py")])
  assert.deepEqual(fl.mentionedPaths("![x](<out/a b.docx>) `out/x y.xlsx`", D, ok, 10), [path.join(D, "out/a b.docx"), path.join(D, "out/x y.xlsx")])
  assert.deepEqual(fl.mentionedPaths("https://x.com/a.pdf ![](http://x.com/b.zip)", D, ok, 10), [])
  assert.deepEqual(fl.mentionedPaths("a.pdf b.pdf c.pdf", D, ok, 2).length, 2)
  assert.deepEqual(fl.mentionedPaths("a.pdf", undefined, ok, 2), [], "a relative path needs a folder")
})

test("toolPaths: OpenCode edit / write / patch calls of the newest turn", () => {
  const tool = (name, input, status = "completed") => ({ type: "tool", name, state: { status, input } })
  const msgs = [
    { type: "assistant", content: [{ type: "text", text: "done" }, tool("write", { path: "b.txt", content: "x" })] },
    {
      type: "assistant",
      content: [
        tool("edit", { path: path.join(proj, "a.py") }),
        tool("edit", { filePath: "bad.py" }, "error"),
        tool("shell", { command: "ls", path: "no.txt" }),
        tool("apply_patch", { patchText: "*** Begin Patch\n*** Add File: c.md\n+x\n*** Update File: d.md\n*** End Patch" }),
      ],
    },
    { type: "user", text: "go" },
    { type: "assistant", content: [tool("write", { path: "old.txt" })] },
  ]
  assert.deepEqual(fl.toolPaths(msgs, proj), ["a.py", "c.md", "d.md", "b.txt"].map((f) => path.join(proj, f)))
  assert.deepEqual(fl.toolPaths([{ type: "compaction" }, ...msgs], proj).length, 0, "a compaction ends the turn too")
  assert.deepEqual(fl.diffPaths([{ file: "x/y.py", status: "added" }, { file: "gone.py", status: "deleted" }, { file: path.join(proj, "m.py"), status: "modified" }], proj), [path.join(proj, "x/y.py"), path.join(proj, "m.py")])
  assert.deepEqual(fl.diffPaths(undefined, proj), [])
})

const fc = (id, status, ...changes) => ({ type: "fileChange", id, status, changes: changes.map(([p, kind, move_path]) => ({ path: p, kind: { type: kind, ...(move_path && { move_path }) }, diff: "d" })) })

test("fileChangePaths: completed items, no deletions, moves at the new path", () => {
  const items = [fc("1", "completed", ["C:\\p\\a.py", "add"], ["\\\\?\\C:\\p\\b.py", "update", null]), fc("2", "failed", ["C:\\p\\x.py", "add"]), fc("3", "completed", ["C:\\p\\d.py", "delete"], ["C:\\p\\e.py", "update", "C:\\p\\f.py"]), { type: "agentMessage", text: "hi" }]
  assert.deepEqual(fl.fileChangePaths(items), ["C:\\p\\a.py", "C:\\p\\b.py", "C:\\p\\f.py"])
  assert.deepEqual(fl.fileChangePaths(undefined), [])
})

test("codexEdited: the turn's fileChange rows from the history db", { skip: !sqlite }, async () => {
  const db = fakeHistory([
    ["t1", 1, user("u1", "a"), "turnA"],
    ["t1", 2, fc("f1", "completed", ["C:\\p\\a.py", "add"], ["C:\\p\\b.py", "update"]), "turnA"],
    ["t1", 3, agent("m1", "ok"), "turnA"],
    ["t1", 4, user("u2", "b"), "turnB"],
    ["t1", 5, fc("f2", "completed", ["C:\\p\\c.py", "add"], ["C:\\p\\d.py", "delete"], ["C:\\p\\e.py", "update", "C:\\p\\f.py"]), "turnB"],
    ["t1", 6, fc("f3", "failed", ["C:\\p\\g.py", "add"]), "turnB"],
    ["t2", 1, fc("f4", "completed", ["C:\\p\\h.py", "add"]), "turnZ"],
  ])
  assert.deepEqual(await fl.codexEdited("t1", "turnA", db), ["C:\\p\\a.py", "C:\\p\\b.py"])
  assert.deepEqual(await fl.codexEdited("t1", "turnB", db), ["C:\\p\\c.py", "C:\\p\\f.py"])
  // No turn id, or one the db doesn't know: everything after the newest user message.
  assert.deepEqual(await fl.codexEdited("t1", undefined, db), ["C:\\p\\c.py", "C:\\p\\f.py"])
  assert.deepEqual(await fl.codexEdited("t1", "turn-nobody-knows", db), ["C:\\p\\c.py", "C:\\p\\f.py"])
  assert.deepEqual(await fl.codexEdited("nope", "x", db), [])
  assert.deepEqual(await fl.codexEdited("t1", "turnA", path.join(tmp, "missing.sqlite")), [])
})

test("humanSize, offerText, names that collide", () => {
  assert.deepEqual([0, 12, 1536, 1258291, 5 * 1024 ** 2].map(fl.humanSize), ["0 B", "12 B", "2 KB", "1.2 MB", "5.0 MB"])
  const P = path.join(tmp, "p")
  const files = [{ path: path.join(P, "report.pdf"), size: 1258291 }, { path: path.join(P, "a.py"), size: 20 }]
  const text = fl.offerText("[3] Codex · proj", files, 2, 3, P)
  assert.equal(text, "[3] Codex · proj 这一轮的文件：\n\n- 1 report.pdf（1.2 MB）\n- 2 a.py（20 B）\n- …还有 2 个\n\n回复「3 文件 1 3」发送选中的，「3 文件 全部」全发，不回复就不发")
  flat(text)
  const same = fl.offerText("[3] Codex · proj", [{ path: path.join(P, "a.py"), size: 5 }, { path: path.join(P, "sub", "a.py"), size: 6 }, { path: path.join(P, "b.txt"), size: 7 }], 0, 3, P)
  assert.ok(same.includes("- 1 a.py（5 B）\n- 2 sub/a.py（6 B）\n- 3 b.txt（7 B）"), same)
  assert.ok(fl.offerText("[3] x", [{ path: path.join(P, "gone.txt"), size: null }], 0, 3, P).includes("- 1 gone.txt（已不存在）"))
  // Colliding names outside the folder show the whole path.
  assert.deepEqual(fl.displayNames([path.join(tmp, "x", "a.py"), path.join(tmp, "y", "a.py")], P).map((s) => s.endsWith("a.py") && s.includes("/")), [true, true])
})

test("parseSelection / resolveSelection", () => {
  for (const [arg, want] of [["1 3", [1, 3]], ["1,3", [1, 3]], ["1，3", [1, 3]], ["1、3", [1, 3]], ["1, 3 ,5", [1, 3, 5]], ["2", [2]], ["3 3 1", [3, 1]]])
    assert.deepEqual(fl.parseSelection(arg), { nums: want }, arg)
  for (const a of ["全部", "全发", "ALL", " all "]) assert.deepEqual(fl.parseSelection(a), { all: true }, a)
  for (const a of ["", "a", "1 a", "名字改一下", "report.pdf", "1.5", "-1", "1 2 x"]) assert.equal(fl.parseSelection(a), null, a)
  assert.deepEqual(fl.resolveSelection({ nums: [1, 3] }, 3), { idx: [0, 2], bad: [] })
  assert.deepEqual(fl.resolveSelection({ nums: [1, 4, 0] }, 3), { idx: [0], bad: [4, 0] })
  assert.deepEqual(fl.resolveSelection({ all: true }, 3), { idx: [0, 1, 2], bad: [] })
})

test("liveOffer: 24 hours", () => {
  const now = Date.now()
  const o = { files: ["a"], at: now }
  assert.equal(fl.liveOffer(o, now + 23 * 3_600_000), o)
  assert.equal(fl.liveOffer(o, now + 24 * 3_600_000 + 1), undefined)
  assert.equal(fl.liveOffer({ files: [], at: now }, now), undefined)
  assert.equal(fl.liveOffer(undefined, now), undefined)
})

test("fileItem: the file_item sendmessage carries", () => {
  const media = { encrypt_query_param: "P", aes_key: "K", encrypt_type: 1 }
  assert.deepEqual(fl.fileItem(media, "r.pdf", 1234), { type: 4, file_item: { file_name: "r.pdf", len: "1234", media } })
})

test("parseCommand: file commands, and chat that must stay chat", () => {
  const p = ix.parseCommand
  assert.deepEqual(p("3 文件 1 3"), { type: "files", n: 3, sel: { nums: [1, 3] } })
  assert.deepEqual(p("3 文件 1,3"), { type: "files", n: 3, sel: { nums: [1, 3] } })
  assert.deepEqual(p("3文件 1，3"), { type: "files", n: 3, sel: { nums: [1, 3] } })
  assert.deepEqual(p("3 文件 全部"), { type: "files", n: 3, sel: { all: true } })
  assert.deepEqual(p("3 文件"), { type: "files", n: 3 })
  assert.deepEqual(p("文件"), { type: "files" })
  assert.deepEqual(p("文件 2"), { type: "files", sel: { nums: [2] } })
  assert.deepEqual(p("文件 全部"), { type: "files", sel: { all: true } })
  assert.deepEqual(p("/file"), { type: "files" })
  assert.deepEqual(p("/file 1 2"), { type: "files", sel: { nums: [1, 2] } })
  assert.deepEqual(p("3 /file 全部"), { type: "files", n: 3, sel: { all: true } })
  assert.deepEqual(p("文件 report.pdf"), { type: "file", path: "report.pdf" })
  assert.deepEqual(p("文件 out/report"), { type: "file", path: "out/report" })
  assert.deepEqual(p("文件 C:\\My Docs\\r.docx"), { type: "file", path: "C:\\My Docs\\r.docx" })
  assert.deepEqual(p("文件 `a b.txt`"), { type: "file", path: "a b.txt" })
  assert.deepEqual(p("/file docs/r.pdf"), { type: "file", path: "docs/r.pdf" })
  assert.deepEqual(p("/file Makefile"), { type: "file", path: "Makefile" })
  assert.deepEqual(p("3 /file r.pdf"), { type: "file", path: "r.pdf" })
  assert.deepEqual(p("文件提示 关"), { type: "filehint", on: false })
  assert.deepEqual(p("文件提示 开"), { type: "filehint", on: true })
  assert.deepEqual(p("文件提示"), { type: "filehint" })
  assert.deepEqual(p("/files off"), { type: "filehint", on: false })
  assert.deepEqual(p("/files ON"), { type: "filehint", on: true })
  assert.deepEqual(p("/files"), { type: "filehint" })
  // Chat.
  assert.deepEqual(p("文件夹里有什么"), { type: "text", text: "文件夹里有什么" })
  assert.deepEqual(p("5 文件名改一下"), { type: "text", n: 5, text: "文件名改一下" })
  assert.deepEqual(p("5 文件 帮我看看"), { type: "text", n: 5, text: "文件 帮我看看" })
  assert.deepEqual(p("5 文件 report.pdf"), { type: "text", n: 5, text: "文件 report.pdf" })
  assert.deepEqual(p("文件 太大了怎么办"), { type: "text", text: "文件 太大了怎么办" })
  assert.deepEqual(p("文件 版本是1.2"), { type: "text", text: "文件 版本是1.2" })
  assert.deepEqual(p("文件提示怎么改"), { type: "text", text: "文件提示怎么改" })
  assert.deepEqual(p("文件夹 2"), { type: "cd", arg: "2" })
  assert.deepEqual(p("3 个文件"), { type: "text", n: 3, text: "个文件" })
  assert.equal(p("/filesystem 是什么").type, "slash")
  assert.equal(p("/files x y").type, "help", "a malformed /files shows help")
})

// --- end to end against the fake iLink ---

const now = () => Date.now()
const state0 = (offers) => ({
  nums: { ses_a: 3, "codex:t1": 4 }, used: { ses_a: now(), "codex:t1": now() }, info: { ses_a: { dir: proj }, "codex:t1": { dir: proj } },
  contextToken: "ctx", target: "ses_a", last: "ses_a", dir: proj, ...(offers && { offers }),
})
let msgNo = 0
const say = async (text) => {
  const out = []
  const msg = { message_type: 1, from_user_id: "u1", message_id: `m${++msgNo}`, create_time_ms: now(), item_list: [{ type: 1, text_item: { text } }] }
  await ix.inbound(msg, () => 0, async (r) => out.push(r))
  return out
}

test("sendFile: getuploadurl, CDN and sendmessage carry what the reference protocol needs", async () => {
  setState(state0())
  log.length = 0
  const content = crypto.randomBytes(1000)
  const f = path.join(tmp, "wx-file-test.txt")
  fs.writeFileSync(f, content)
  const steps = await ix.sendFile(f)
  assert.match(steps, /^getuploadurl http=200 ret=0 errcode=0, cdn http=200, sendmessage http=200 ret=0 errcode=0$/)
  assert.deepEqual(log.map((c) => c.path), ["/ilink/bot/getuploadurl", "/c2c/upload", "/ilink/bot/sendmessage"])
  const up = json(log[0])
  const key = Buffer.from(up.aeskey, "hex")
  assert.equal(up.media_type, 3, "files are upload media type 3 (images 1)")
  assert.equal(up.to_user_id, "u1")
  assert.equal(up.rawsize, 1000)
  assert.equal(up.rawfilemd5, crypto.createHash("md5").update(content).digest("hex"))
  assert.equal(up.filesize, Math.ceil((1000 + 1) / 16) * 16)
  assert.match(up.filekey, /^[0-9a-f]{32}$/)
  assert.match(up.aeskey, /^[0-9a-f]{32}$/)
  assert.equal(up.no_need_thumb, true)
  assert.ok(up.base_info?.channel_version)
  assert.equal(log[0].headers.authorization, "Bearer tok")
  // The CDN gets the AES-128-ECB ciphertext, addressed by the upload_param and the same filekey.
  assert.equal(log[1].query.get("encrypted_query_param"), "UP1")
  assert.equal(log[1].query.get("filekey"), up.filekey)
  assert.equal(log[1].body.length, up.filesize)
  const d = crypto.createDecipheriv("aes-128-ecb", key, null)
  assert.ok(Buffer.concat([d.update(log[1].body), d.final()]).equals(content))
  // sendmessage: a type 4 item with file_name, len as a string, and the CDN's download param with the key as base64 of its hex.
  const { msg } = json(log[2])
  assert.equal(msg.message_type, 2)
  assert.equal(msg.message_state, 2)
  assert.equal(msg.to_user_id, "u1")
  assert.equal(msg.context_token, "ctx")
  assert.deepEqual(msg.item_list, [
    { type: 4, file_item: { file_name: "wx-file-test.txt", len: "1000", media: { encrypt_query_param: "DL2", aes_key: Buffer.from(up.aeskey).toString("base64"), encrypt_type: 1 } } },
  ])
  // Images keep working through the same upload (media type 1, image_item with the encrypted size).
  log.length = 0
  const img = path.join(tmp, "p.png")
  fs.writeFileSync(img, Buffer.alloc(40, 1))
  await ix.sendImage(img)
  assert.equal(json(log[0]).media_type, 1)
  assert.equal(json(log[2]).msg.item_list[0].image_item.mid_size, 48)
})

test("sendFile: missing, empty and over-limit files never reach the network", async () => {
  log.length = 0
  await assert.rejects(ix.sendFile(path.join(tmp, "nope.bin")), /nope\.bin 文件不存在/)
  await assert.rejects(ix.sendFile(write("empty.bin", 0)), /empty\.bin 是空文件/)
  await assert.rejects(ix.sendFile(proj), /文件不存在/)
  const big = write("big.bin", 0)
  fs.truncateSync(big, 50 * 1024 ** 2 + 1)
  await assert.rejects(ix.sendFile(big), /big\.bin 太大（超过 50 MB）/)
  fs.truncateSync(big, 0)
  assert.equal(log.length, 0)
})

test("「N 文件」 commands: list, select, errors, expiry", async () => {
  const f1 = write("report.pdf", 1258291)
  const f2 = write("a.py", 20)
  const f3 = write("b.txt", 7)
  setState(state0({ ses_a: { files: [f1, f2, f3], at: now() } }))
  log.length = 0
  const list = await say("3 文件")
  assert.equal(list.length, 1)
  assert.ok(list[0].startsWith("[3] OpenCode · proj 这一轮的文件：\n\n- 1 report.pdf（1.2 MB）\n- 2 a.py（20 B）\n- 3 b.txt（7 B）\n\n回复「3 文件 1 3」"), list[0])
  flat(list)
  assert.equal(log.length, 0, "listing sends nothing but the reply")

  assert.deepEqual(await say("3 文件 1 3"), ["已发送 2 个文件"])
  assert.deepEqual(sent().map((i) => i.file_item.file_name), ["report.pdf", "b.txt"])
  assert.deepEqual(calls("/ilink/bot/getuploadurl").map((c) => json(c).media_type), [3, 3])

  log.length = 0
  assert.deepEqual(await say("文件 全部"), ["已发送 3 个文件"], "no number: the current target conversation")
  assert.deepEqual(sent().map((i) => i.file_item.file_name), ["report.pdf", "a.py", "b.txt"])

  log.length = 0
  assert.deepEqual(await say("3 文件 2 7"), ["[3] OpenCode · proj 没有第 7 个文件（共 3 个），发「3 文件」看列表"])
  assert.deepEqual(await say("文件 0"), ["[3] OpenCode · proj 没有第 0 个文件（共 3 个），发「3 文件」看列表"])
  assert.equal(log.length, 0, "an unknown number sends nothing")
  assert.match((await say("9 文件"))[0], /^没有 \[9\]/)
  assert.match((await say("4 文件"))[0], /^\[4\] Codex · proj 没有可选的文件/)

  // A file that is gone by now is reported, the others still go.
  fs.rmSync(f2)
  assert.deepEqual(await say("3 文件 1 2"), ["已发送 1 个文件\n\n没发出去：a.py（文件不存在）"])
  assert.deepEqual(await say("3 文件 2"), ["没发出去：a.py（文件不存在）"])
  assert.ok((await say("3 文件"))[0].includes("- 2 a.py（已不存在）"))

  // Ordinary chat is not a command: it would go to the conversation (OpenCode isn't running here).
  assert.match((await say("5 文件名改一下"))[0], /^没有 \[5\]/)
  assert.match((await say("文件夹里有什么"))[0], /OpenCode 没在运行/)

  // Expired.
  setState(state0({ ses_a: { files: [f1], at: now() - 24 * 3_600_000 - 1000 } }))
  assert.match((await say("3 文件 1"))[0], /^\[3\] OpenCode · proj 没有可选的文件/)
})

test("「文件 路径」: any file by path, secrets included, size limit applies", async () => {
  setState(state0())
  log.length = 0
  const env = write(".env", 12)
  assert.deepEqual(await say("文件 .env"), [], "no secret filter for an explicit path")
  assert.equal(sent()[0].file_item.file_name, ".env")
  write("sub/a.py")
  log.length = 0
  assert.deepEqual(await say("/file sub/a.py"), [])
  assert.equal(sent()[0].file_item.file_name, "a.py")
  assert.deepEqual(await say(`文件 ${env}`), [], "absolute path")
  assert.match((await say("文件 missing.bin"))[0], /^出错了：missing\.bin 文件不存在/)
  const big = write("big.bin", 0)
  fs.truncateSync(big, 50 * 1024 ** 2 + 1)
  log.length = 0
  assert.match((await say("文件 big.bin"))[0], /^出错了：big\.bin 太大（超过 50 MB）/)
  fs.truncateSync(big, 0)
  assert.equal(log.length, 0)
  setState({ ...state0(), dir: undefined })
  assert.equal((await say("文件 a.pdf"))[0], "相对路径要先发「目录」选文件夹")
  assert.equal((await say("文件 https://x.com/a.pdf"))[0], "只能发电脑上的文件")
})

test("offerFiles: one message after the turn, stored per conversation, replaced by the next", async () => {
  setState(state0({ "codex:t1": { files: ["old"], at: now() } }))
  const a = write("out/result.pdf", 2048)
  const b = write("out/main.py", 100)
  const c = write("out/more.py", 100)
  write("out/secret.pem")
  log.length = 0
  await ix.offerFiles("ses_a", { reply: `导出在 \`${a}\``, dir: proj, edited: () => [b, path.join(proj, "out/secret.pem"), a] })
  assert.equal(sent().length, 1)
  const text = sent()[0].text_item.text
  assert.equal(text, `[3] OpenCode · proj 这一轮的文件：\n\n- 1 result.pdf（2 KB）\n- 2 main.py（100 B）\n\n回复「3 文件 1 3」发送选中的，「3 文件 全部」全发，不回复就不发`)
  const s = getState()
  assert.deepEqual(s.offers.ses_a.files, [a, b])
  assert.ok(now() - s.offers.ses_a.at < 5000)
  assert.deepEqual(s.offers["codex:t1"].files, ["old"], "other conversations keep theirs")
  assert.equal(s.last, "ses_a")

  // The next turn replaces the offer; a turn without files sends nothing and keeps it.
  log.length = 0
  await ix.offerFiles("ses_a", { reply: "", dir: proj, edited: [c] })
  assert.deepEqual(getState().offers.ses_a.files, [c])
  assert.equal(sent().length, 1)
  log.length = 0
  await ix.offerFiles("ses_a", { reply: "没改文件", dir: proj, edited: [] })
  assert.equal(log.length, 0)
  assert.deepEqual(getState().offers.ses_a.files, [c])

  // Switched off: nothing is looked up, sent or stored.
  assert.match((await say("文件提示 关"))[0], /已关闭/)
  assert.equal(getState().filesOff, true)
  assert.equal((await say("文件提示"))[0].split("\n")[0], "文件提示：关")
  log.length = 0
  let looked = false
  await ix.offerFiles("ses_a", { reply: "", dir: proj, edited: async () => ((looked = true), [a]) })
  assert.equal(log.length, 0)
  assert.equal(looked, false)
  assert.deepEqual(getState().offers.ses_a.files, [c])
  assert.match((await say("/files on"))[0], /已打开/)
  assert.equal(getState().filesOff, false)
  assert.equal((await say("文件提示"))[0].split("\n")[0], "文件提示：开")
})

test("prune drops the offers of released numbers and expired offers", async () => {
  const stale = now() - 25 * 3_600_000
  setState({
    ...state0(),
    nums: { ses_a: 3, "codex:old": 5, "codex:new": 6 }, target: "ses_a", last: "ses_a",
    used: { ses_a: now(), "codex:old": stale, "codex:new": now() },
    offers: { ses_a: { files: ["x"], at: stale }, "codex:old": { files: ["x"], at: now() }, "codex:new": { files: ["x"], at: now() } },
  })
  await ix.prune()
  const s = getState()
  assert.deepEqual(Object.keys(s.nums).sort(), ["codex:new", "ses_a"])
  assert.deepEqual(Object.keys(s.offers), ["codex:new"])
})

test("onStop: offers the turn's files through the receiving process", { skip: !sqlite }, async () => {
  const offers = []
  const m = {
    PENDING_DIR: path.join(tmp, "pending"), base: (d) => path.basename(d), short: (s) => s, clip: (t) => t, assign: async () => 7, update: () => {}, state: () => ({ pollerPid: process.pid }),
    replyImages: async () => ({ files: [], big: [] }), send: async () => "ok", sendImage: async () => {},
    offerFiles: async (key, o) => offers.push([key, o.reply, o.dir, await o.edited()]),
  }
  const db = fakeHistory([
    ["st1", 1, user("u1", "a"), "turnA"],
    ["st1", 2, fc("f1", "completed", ["C:\\p\\a.py", "add"]), "turnA"],
    ["st1", 3, user("u2", "b"), "turnB"],
    ["st1", 4, fc("f2", "completed", ["C:\\p\\b.py", "add"], ["C:\\p\\c.pdf", "add"]), "turnB"],
  ])
  const p = { session_id: "st1", turn_id: "turnB", cwd: "C:\\p", last_assistant_message: "生成了 C:\\p\\c.pdf" }
  await onStop(p, m, { db })
  assert.deepEqual(offers, [["codex:st1", "生成了 C:\\p\\c.pdf", "C:\\p", ["C:\\p\\b.py", "C:\\p\\c.pdf"]]])
  // An older plugin build without offerFiles still gets its push.
  const { offerFiles, ...old } = m
  await onStop(p, old, { db })
  assert.equal(offers.length, 1)
})

test("bridge turns hand their fileChange items to the push", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "bridge-"))
  const pushed = []
  const b = createBridge({ push: (...a) => pushed.push(a), markerDir: dir, bin: () => [process.execPath, path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-app-server.js")] })
  try {
    await b.send("edit", "write a.py")
    for (let i = 0; i < 300 && !pushed.some((p) => p[1] === "done"); i++) await new Promise((r) => setTimeout(r, 10))
    const done = pushed.find((p) => p[1] === "done")
    assert.equal(done[2], "写好了 a.py")
    assert.deepEqual(fl.fileChangePaths(done[3].fileChanges), ["C:\\p\\a.py"])
    // A turn that changed nothing pushes the same three arguments as before.
    await b.send("echo", "hi")
    for (let i = 0; i < 300 && !pushed.some((p) => p[0] === "echo" && p[1] === "done"); i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(pushed.find((p) => p[0] === "echo" && p[1] === "done").length, 3)
  } finally {
    b.stop()
  }
})
