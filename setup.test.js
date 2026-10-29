import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { addPlugin, mergeHooks, parseJsonc } from "./setup.js"

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const DIR = path.join(path.parse(ROOT).root, "x", "agent-wechat-bridge")
const ENTRY = DIR.replace(/\\/g, "/")
const add = (text, cfgDir) => {
  const r = addPlugin(text, DIR, cfgDir)
  assert.equal(r.state, "add")
  assert.equal(addPlugin(r.text, DIR, cfgDir).state, "ok", "second run changes nothing")
  return r.text
}

test("addPlugin keeps comments and layout", () => {
  const a = `// top comment
{
  "$schema": "https://opencode.ai/config.json", // keep //
  /* block */ "model": "a/b",
  "plugins": [
    "some-plugin", // keep me
    "./local" /* and me */
  ],
}
`
  assert.equal(add(a), a.replace('"./local" /* and me */\n', `"./local", /* and me */\n    "${ENTRY}"\n`))
  const trailing = `{\n  "plugins": [\n    "a",\n  ]\n}`
  assert.equal(add(trailing), `{\n  "plugins": [\n    "a",\n    "${ENTRY}",\n  ]\n}`)
  assert.equal(add(`{"plugins": ["a"]}`), `{"plugins": ["a", "${ENTRY}"]}`)
  assert.equal(add(`{"plugins": []}`), `{"plugins": ["${ENTRY}"]}`)
  assert.equal(add(`{}`), `{"plugins": ["${ENTRY}"]}`)
  const o = add(`{"plugins":[{"package":"@a/b","options":{"k":[1,2]}}]}`)
  assert.equal(parseJsonc(o).plugins.length, 2)
})

test("addPlugin without a plugins key", () => {
  assert.equal(add(`{\n  "model": "x",\n}`), `{\n  "model": "x",\n  "plugins": ["${ENTRY}"],\n}`)
  assert.equal(add(`{\n  "model": "x" // m\n}`), `{\n  "model": "x", // m\n  "plugins": ["${ENTRY}"]\n}`)
  const tricky = `{ // "plugins": ["x"]\n  "note": "plugins", "url": "http://a//b" }`
  assert.deepEqual(parseJsonc(add(tricky)).plugins, [ENTRY])
  assert.deepEqual(parseJsonc(addPlugin("", DIR).text).plugins, [ENTRY], "missing file")
})

test("addPlugin keeps CRLF and BOM", () => {
  const t = add("\uFEFF{\r\n  // c\r\n  \"plugins\": [\r\n    \"a\"\r\n  ]\r\n}\r\n")
  assert.ok(t.startsWith("\uFEFF{"))
  assert.ok(!/[^\r]\n/.test(t), "no bare LF")
})

test("addPlugin recognises an existing entry", () => {
  const cfg = path.dirname(DIR)
  for (const spec of [ENTRY, DIR, `${ENTRY}/`, pathToFileURL(DIR).href, "./agent-wechat-bridge"]) {
    assert.equal(addPlugin(JSON.stringify({ plugins: [spec] }), DIR, cfg).state, "ok", spec)
  }
  assert.equal(addPlugin(JSON.stringify({ plugins: [{ package: ENTRY }] }), DIR, cfg).state, "ok", "object form")
  for (const spec of ["agent-wechat-bridge", "agent-wechat-bridge@1.2.0", "/old/opencode-wechat-notify"]) {
    assert.deepEqual(addPlugin(JSON.stringify({ plugins: [spec] }), DIR, cfg), { state: "other", spec })
  }
})

test("addPlugin refuses what it can't edit safely", () => {
  assert.throws(() => addPlugin("[1]", DIR), /not an object/)
  assert.throws(() => addPlugin(`{"plugins": "x"}`, DIR), /not an array/)
  assert.throws(() => addPlugin(`{"a": 1 /* oops`, DIR), /unterminated comment/)
  assert.throws(() => addPlugin(`{"a": 1`, DIR), /unbalanced/)
})

test("mergeHooks adds the three hooks and keeps everything else", () => {
  const script = path.join(DIR, "codex-hook.js")
  const old = {
    description: "mine",
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "echo hi", timeout: 5 }] }],
      PostToolUse: [{ matcher: "x", hooks: [] }],
    },
  }
  const copy = structuredClone(old)
  const r = mergeHooks(old, script)
  assert.deepEqual(old, copy, "input is not mutated")
  assert.deepEqual(r.added, ["Stop", "PermissionRequest", "PreToolUse"])
  assert.equal(r.json.description, "mine")
  assert.deepEqual(r.json.hooks.PostToolUse, old.hooks.PostToolUse)
  assert.deepEqual(r.json.hooks.Stop[0], old.hooks.Stop[0])
  assert.equal(r.json.hooks.Stop[1].hooks[0].command, `node "${script}" Stop`)
  assert.equal(r.json.hooks.PermissionRequest[0].hooks[0].timeout, 600)
  assert.equal(r.json.hooks.PreToolUse[0].matcher, "request_user_input")
  const again = mergeHooks(r.json, script)
  assert.deepEqual([again.added, again.same.length], [[], 3], "idempotent")
  assert.deepEqual(again.json, r.json)
  assert.deepEqual(mergeHooks({}, script).added.length, 3, "empty file")
})

test("mergeHooks leaves a hook that points elsewhere alone", () => {
  const stop = { hooks: [{ type: "command", command: 'node "D:\\old dir\\codex-hook.js" Stop' }] }
  const r = mergeHooks({ hooks: { Stop: [stop] } }, path.join(DIR, "codex-hook.js"))
  assert.deepEqual(r.other, [{ event: "Stop", path: "D:\\old dir\\codex-hook.js" }])
  assert.deepEqual(r.added, ["PermissionRequest", "PreToolUse"])
  assert.deepEqual(r.json.hooks.Stop, [stop])
  assert.throws(() => mergeHooks({ hooks: [] }, "x"), /not an object/)
  assert.throws(() => mergeHooks({ hooks: { Stop: {} } }, "x"), /not an array/)
})

test("package.json files covers every runtime import and nothing else", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"))
  for (const f of pkg.files.filter((f) => f.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8")
    for (const m of src.matchAll(/(?:from\s+|import\()\s*["']\.\/([^"']+)["']/g)) {
      assert.ok(pkg.files.includes(m[1]), `${f} imports ${m[1]}, which is not in package.json files`)
    }
  }
  assert.ok(!pkg.files.some((f) => /test|fake-/.test(f)))
  assert.ok(pkg.files.includes(pkg.bin["agent-wechat-bridge"]))
})

test("setup.js end to end against a fake HOME", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "awb-setup-"))
  try {
    const env = (home) => {
      const e = { ...process.env, HOME: home, USERPROFILE: home }
      delete e.WECHAT_NOTIFY_DIR
      return e
    }
    const run = (home, ...args) => {
      const r = spawnSync(process.execPath, [path.join(ROOT, "setup.js"), ...args], { env: env(home), encoding: "utf8" })
      return { code: r.status, out: r.stdout + r.stderr }
    }
    const read = (f) => fs.readFileSync(f, "utf8")
    const baks = (d) => fs.readdirSync(d).filter((f) => f.includes(".bak-")).length

    const home = path.join(tmp, "home")
    const cfgDir = path.join(home, ".config", "opencode")
    const cfg = path.join(cfgDir, "opencode.jsonc")
    const hooks = path.join(home, ".codex", "hooks.json")
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.mkdirSync(path.dirname(hooks), { recursive: true })
    fs.mkdirSync(path.join(home, ".cli-bridge"))
    fs.writeFileSync(path.join(home, ".cli-bridge", "account.json"), "{}")
    fs.writeFileSync(cfg, `// my config\n{\n  "model": "a/b", // keep\n  "plugins": [\n    "other-plugin" // keep too\n  ]\n}\n`)
    fs.writeFileSync(hooks, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }, null, 2))
    const [cfg0, hooks0] = [read(cfg), read(hooks)]

    let r = run(home, "setup", "--dry-run")
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /would add .*opencode\.jsonc/)
    assert.match(r.out, /would add Codex hooks Stop, PermissionRequest, PreToolUse/)
    assert.deepEqual([read(cfg), read(hooks), baks(cfgDir), baks(path.dirname(hooks))], [cfg0, hooks0, 0, 0], "dry run writes nothing")

    r = run(home, "setup")
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /\/hooks/)
    const text = read(cfg)
    assert.ok(text.includes("// my config") && text.includes("// keep too"), "comments survive")
    assert.deepEqual(parseJsonc(text).plugins, ["other-plugin", ROOT.replace(/\\/g, "/")])
    const h = JSON.parse(read(hooks)).hooks
    assert.equal(h.Stop.length, 2)
    assert.equal(h.Stop[1].hooks[0].command, `node "${path.join(ROOT, "codex-hook.js")}" Stop`)
    assert.deepEqual([baks(cfgDir), baks(path.dirname(hooks))], [1, 1])

    const [cfg1, hooks1] = [read(cfg), read(hooks)]
    r = run(home, "setup")
    assert.match(r.out, /Nothing to change/)
    assert.deepEqual([read(cfg), read(hooks), baks(cfgDir), baks(path.dirname(hooks))], [cfg1, hooks1, 1, 1], "idempotent")

    // Missing files, no login, one side only.
    const home2 = path.join(tmp, "home2")
    fs.mkdirSync(home2)
    r = run(home2, "--opencode-only")
    assert.match(r.out, /npx -p cli-chat-bridge wechat-setup/)
    assert.doesNotMatch(r.out, /\/hooks/, "no Codex step when no hooks were added")
    assert.deepEqual(parseJsonc(read(path.join(home2, ".config", "opencode", "opencode.json"))).plugins, [ROOT.replace(/\\/g, "/")])
    assert.ok(!fs.existsSync(path.join(home2, ".codex")))
    r = run(home2, "--codex-only")
    assert.equal(JSON.parse(read(path.join(home2, ".codex", "hooks.json"))).hooks.PreToolUse.length, 1)
    assert.equal(run(home2, "--codex-only", "--opencode-only").code, 2)
    assert.equal(run(home2, "--nope").code, 2)

    // A file we can't edit without losing comments is refused and left alone.
    const home3 = path.join(tmp, "home3")
    fs.mkdirSync(path.join(home3, ".config", "opencode"), { recursive: true })
    const bad = path.join(home3, ".config", "opencode", "opencode.json")
    fs.writeFileSync(bad, `{ "plugins": "oops" // c\n}`)
    r = run(home3, "--opencode-only")
    assert.equal(r.code, 1)
    assert.equal(read(bad), `{ "plugins": "oops" // c\n}`)

    // npx runs from a temporary folder: setup copies the files somewhere permanent and points at the copy.
    const pkg = JSON.parse(read(path.join(ROOT, "package.json")))
    const npx = path.join(tmp, "cache", "_npx", "abc", "node_modules", "agent-wechat-bridge")
    fs.mkdirSync(npx, { recursive: true })
    for (const f of [...pkg.files, "package.json"]) fs.copyFileSync(path.join(ROOT, f), path.join(npx, f))
    const home4 = path.join(tmp, "home4")
    fs.mkdirSync(path.join(home4, ".codex"), { recursive: true })
    const res = spawnSync(process.execPath, [path.join(npx, "setup.js")], { env: env(home4), encoding: "utf8" })
    const kept = path.join(home4, ".cli-bridge", "agent-wechat-bridge")
    assert.equal(res.status, 0, res.stdout + res.stderr)
    assert.ok(fs.existsSync(path.join(kept, "index.js")) && fs.existsSync(path.join(kept, "package.json")))
    assert.deepEqual(parseJsonc(read(path.join(home4, ".config", "opencode", "opencode.json"))).plugins, [kept.replace(/\\/g, "/")])
    assert.ok(read(path.join(home4, ".codex", "hooks.json")).includes(JSON.stringify(path.join(kept, "codex-hook.js")).slice(1, -1)))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
