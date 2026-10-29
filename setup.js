#!/usr/bin/env node
// One-command setup: registers this folder as an OpenCode plugin and adds the three Codex hooks. Node stdlib only.
//   npx agent-wechat-bridge setup [--dry-run] [--opencode-only | --codex-only]
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const NAME = "agent-wechat-bridge"
const slash = (p) => p.replace(/\\/g, "/")
const norm = (p) => {
  const s = slash(path.resolve(p)).replace(/\/+$/, "")
  return process.platform === "win32" ? s.toLowerCase() : s
}

// --- JSONC: edit the text, never re-serialize, so comments and formatting survive ---

const OPEN = new Set(["{", "["])
const CLOSE = new Set(["}", "]"])
const WORD = /[^\s{}[\]:,"/]+/y

// Tokens with comments and whitespace skipped. Each keeps its offsets so edits can be textual.
export function tokens(text) {
  const out = []
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === "/" && text[i + 1] === "/") {
      const e = text.indexOf("\n", i)
      i = e < 0 ? text.length : e
    } else if (c === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2)
      if (e < 0) throw new Error("unterminated comment")
      i = e + 2
    } else if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1
      if (j >= text.length) throw new Error("unterminated string")
      out.push({ t: text.slice(i, j + 1), start: i, end: j + 1 })
      i = j + 1
    } else if ("{}[]:,".includes(c)) {
      out.push({ t: c, start: i, end: i + 1 })
      i++
    } else if (/\s/.test(c)) i++
    else {
      WORD.lastIndex = i
      const m = WORD.exec(text)
      if (!m) throw new Error(`unexpected "${c}" at offset ${i}`)
      out.push({ t: m[0], start: i, end: i + m[0].length })
      i += m[0].length
    }
  }
  return out
}

export function parseJsonc(text) {
  const ts = tokens(text)
  return JSON.parse(ts.filter((x, i) => !(x.t === "," && CLOSE.has(ts[i + 1]?.t))).map((x) => x.t).join(" "))
}

// Index of the token that closes the bracket opened at ts[i].
function closer(ts, i) {
  for (let j = i, d = 0; j < ts.length; j++) {
    if (OPEN.has(ts[j].t)) d++
    else if (CLOSE.has(ts[j].t) && --d === 0) return j
  }
  throw new Error("unbalanced brackets")
}

// Index of the value token of `key` in the object opened at ts[o], or -1.
function member(ts, o, key) {
  const end = closer(ts, o)
  for (let j = o + 1, d = 0; j < end; j++) {
    const t = ts[j].t
    if (OPEN.has(t)) d++
    else if (CLOSE.has(t)) d--
    else if (d === 0 && ts[j + 1]?.t === ":" && t[0] === '"' && JSON.parse(t) === key) return j + 2
  }
  return -1
}

// Items of the array opened at ts[a], as { i, j } token ranges.
function elements(ts, a) {
  const end = closer(ts, a)
  const out = []
  for (let j = a + 1; j < end; j++) {
    if (ts[j].t === ",") continue
    const e = OPEN.has(ts[j].t) ? closer(ts, j) : j
    out.push({ i: j, j: e })
    j = e
  }
  return out
}

// The plugin spec of an item: a string, or the "package" of an { package, options } object.
function specOf(ts, el) {
  const t = ts[el.i].t
  if (t[0] === '"') return JSON.parse(t)
  const v = t === "{" ? member(ts, el.i, "package") : -1
  if (v >= 0 && ts[v].t[0] === '"') return JSON.parse(ts[v].t)
}

// Append `item` as the last member/element of the container opened at ts[o].
function insert(text, ts, o, item) {
  const c = closer(ts, o)
  if (c === o + 1) return text.slice(0, ts[o].end) + item + text.slice(ts[o].end)
  const trailing = ts[c - 1].t === ","
  const lastEnd = ts[trailing ? c - 2 : c - 1].end
  const ls = text.lastIndexOf("\n", ts[c].start) + 1
  // Closing bracket inline: ["a", "b"] -> ["a", "b", item]
  if (text.slice(ls, ts[c].start).trim()) return text.slice(0, lastEnd) + ", " + item + text.slice(lastEnd)
  // Closing bracket alone on its line: new line before it, same indentation as the first item.
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  const indent = /^[ \t]*/.exec(text.slice(text.lastIndexOf("\n", ts[o + 1].start) + 1))[0]
  const line = indent + item + (trailing ? "," : "") + eol
  const withLine = text.slice(0, ls) + line + text.slice(ls)
  return trailing ? withLine : withLine.slice(0, lastEnd) + "," + withLine.slice(lastEnd)
}

const readName = (p) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(p, "package.json"), "utf8")).name
  } catch {}
}
const isBridge = (p) => /(^|[\\/])(agent-wechat-bridge|opencode-wechat-notify)$/i.test(p) || readName(p) === NAME

// "same" = this folder, "other" = looks like this plugin from somewhere else, undefined = unrelated.
function classify(spec, dir, cfgDir) {
  let p
  try {
    if (spec.startsWith("file:")) p = fileURLToPath(spec)
    else if (/^\.{1,2}([\\/]|$)/.test(spec)) p = path.resolve(cfgDir, spec)
    else if (path.isAbsolute(spec) || /^[a-z]:[\\/]/i.test(spec)) p = spec
  } catch {
    return
  }
  if (!p) return /^(agent-wechat-bridge|opencode-wechat-notify)(@|$)/.test(spec) ? "other" : undefined
  if (norm(p) === norm(dir)) return "same"
  return isBridge(p) ? "other" : undefined
}

// text = opencode.json(c) content, "" when the file is missing. -> { state: "ok" } | { state: "other", spec } |
// { state: "add", text }. Throws (message is shown to the user) when the file can't be edited without losing something.
export function addPlugin(text, dir, cfgDir = ".") {
  const entry = slash(dir)
  const ts = tokens(text)
  if (!ts.length) {
    return { state: "add", text: `{\n  "$schema": "https://opencode.ai/config.json",\n  "plugins": [${JSON.stringify(entry)}]\n}\n` }
  }
  if (ts[0].t !== "{") throw new Error("the top level is not an object")
  const at = member(ts, 0, "plugins")
  let next
  if (at < 0) next = insert(text, ts, 0, `"plugins": [${JSON.stringify(entry)}]`)
  else {
    if (ts[at].t !== "[") throw new Error('"plugins" is not an array')
    for (const el of elements(ts, at)) {
      const spec = specOf(ts, el)
      const kind = spec && classify(spec, dir, cfgDir)
      if (kind === "same") return { state: "ok" }
      if (kind) return { state: "other", spec }
    }
    next = insert(text, ts, at, JSON.stringify(entry))
  }
  const before = parseJsonc(text)
  const after = parseJsonc(next)
  assert.deepEqual({ ...after, plugins: 0 }, { ...before, plugins: 0 })
  assert.deepEqual(after.plugins, [...(before.plugins ?? []), entry])
  return { state: "add", text: next }
}

// --- Codex hooks.json (plain JSON) ---

const HOOKS = [
  ["Stop", {}, { timeout: 15 }],
  ["PermissionRequest", {}, { timeout: 600, statusMessage: "等微信批准" }],
  ["PreToolUse", { matcher: "request_user_input" }, { timeout: 15 }],
]
const CMD = /^\s*(?:node(?:\.exe)?\s+)?"?(.*?codex-hook\.js)"?\s+(\w+)\s*$/i

// json = parsed hooks.json, script = absolute path of codex-hook.js. Never removes or edits an existing entry.
// -> { json, added: [event], same: [event], other: [{ event, path }] }
export function mergeHooks(json, script) {
  const out = structuredClone(json)
  const hooks = (out.hooks ??= {})
  if (typeof hooks !== "object" || Array.isArray(hooks)) throw new Error('"hooks" is not an object')
  const res = { json: out, added: [], same: [], other: [] }
  for (const [event, group, hook] of HOOKS) {
    const groups = (hooks[event] ??= [])
    if (!Array.isArray(groups)) throw new Error(`hooks.${event} is not an array`)
    const mine = groups
      .flatMap((g) => g?.hooks ?? [])
      .map((h) => CMD.exec(h?.command ?? ""))
      .filter((m) => m?.[2] === event)
    const same = mine.some((m) => norm(m[1]) === norm(script))
    if (same) res.same.push(event)
    else if (mine.length) res.other.push({ event, path: mine[0][1] })
    else {
      groups.push({ ...group, hooks: [{ type: "command", command: `node "${script}" ${event}`, ...hook }] })
      res.added.push(event)
    }
  }
  return res
}

const dump = (json, text) =>
  JSON.stringify(json, null, /^[ \t]+(?=")/m.exec(text)?.[0] ?? "  ").replace(/\n/g, text.includes("\r\n") ? "\r\n" : "\n") +
  (text.endsWith("\n") || !text ? "\n" : "")

// --- the command ---

const FLAGS = ["--dry-run", "--opencode-only", "--codex-only"]
const USAGE = `Usage: agent-wechat-bridge setup [--dry-run] [--opencode-only | --codex-only]

  --dry-run         print what would change, write nothing
  --opencode-only   only add the plugin to ~/.config/opencode/opencode.json(c), even if OpenCode is not detected
  --codex-only      only add the Codex hooks to ~/.codex/hooks.json`

// OpenCode counts as installed when its config dir or desktop data dir exists, or `opencode` is on PATH.
export function hasOpenCode(home, env = process.env, platform = process.platform) {
  if (fs.existsSync(path.join(home, ".config", "opencode"))) return true
  if (platform === "win32" && env.APPDATA && fs.existsSync(path.join(env.APPDATA, "ai.opencode.desktop"))) return true
  const exts = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""]
  return (env.PATH ?? env.Path ?? "").split(path.delimiter).some((d) => d && exts.some((x) => fs.existsSync(path.join(d, `opencode${x}`))))
}

const stamp = () => new Date().toISOString().replace(/\D/g, "").slice(0, 14)

export function main(argv) {
  const args = argv.filter((a) => a !== "setup")
  if (args.includes("--help") || args.includes("-h")) return console.log(USAGE), 0
  if (args.some((a) => !FLAGS.includes(a)) || (args.includes("--opencode-only") && args.includes("--codex-only"))) {
    return console.error(USAGE), 2
  }
  const dry = args.includes("--dry-run")
  const wantOpencode = !args.includes("--codex-only")
  const wantCodex = !args.includes("--opencode-only")
  const home = os.homedir()
  const bridge = process.env.WECHAT_NOTIFY_DIR || path.join(home, ".cli-bridge")
  let failed = false
  let changed = false
  let pluginAdded = false
  let hooksAdded = false
  const say = (tag, msg) => console.log(`[${tag}] ${msg}`)
  const fail = (msg) => ((failed = true), say("FAIL", msg))
  const write = (file, text, existed) => {
    if (existed) fs.copyFileSync(file, `${file}.bak-${stamp()}`)
    else fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
  const verb = dry ? "would add" : "added"

  console.log(`${NAME} setup${dry ? " (dry run, nothing is written)" : ""}`)

  // npx runs from a cache folder that npm deletes later: copy the runtime files somewhere permanent and point at those.
  let dir = HERE
  if (/[\\/](_npx|dlx)[\\/]/.test(HERE)) {
    dir = path.join(bridge, NAME)
    const files = [...JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8")).files, "package.json"]
    const stale = files.filter((f) => {
      const to = path.join(dir, f)
      return !fs.existsSync(to) || Buffer.compare(fs.readFileSync(path.join(HERE, f)), fs.readFileSync(to))
    })
    if (stale.length) {
      changed = true
      if (!dry) {
        fs.mkdirSync(dir, { recursive: true })
        for (const f of stale) fs.copyFileSync(path.join(HERE, f), path.join(dir, f))
      }
      say(dry ? "plan" : "done", `${dry ? "would copy" : "copied"} ${stale.length} files to ${dir} (npx's cache folder is temporary)`)
    }
  }
  console.log(`install folder: ${dir}`)

  const account = path.join(bridge, "account.json")
  if (fs.existsSync(account)) say("ok", `WeChat login found (${account})`)
  else {
    say("todo", `WeChat is not logged in yet (no ${account}). Log in once, scan the QR code with WeChat, then run setup again:`)
    console.log("         npx -p cli-chat-bridge wechat-setup")
    console.log("       (or: npm i -g cli-chat-bridge, then run: wechat-setup)")
  }

  if (wantOpencode && !args.includes("--opencode-only") && !hasOpenCode(home)) {
    say("skip", "OpenCode not found; run setup again after installing it (or force with --opencode-only)")
  } else if (wantOpencode) {
    const cfgDir = path.join(home, ".config", "opencode")
    const file = ["opencode.jsonc", "opencode.json"].map((f) => path.join(cfgDir, f)).find((f) => fs.existsSync(f)) ?? path.join(cfgDir, "opencode.json")
    const existed = fs.existsSync(file)
    try {
      const text = existed ? fs.readFileSync(file, "utf8") : ""
      const r = addPlugin(text, dir, cfgDir)
      if (r.state === "ok") say("ok", `OpenCode plugin already configured (${file})`)
      else if (r.state === "other") {
        say("warn", `${file} already lists "${r.spec}", which looks like this plugin from another location. Left unchanged; replace it by hand with "${slash(dir)}" if you want this copy.`)
      } else {
        changed = pluginAdded = true
        if (!dry) {
          write(file, r.text, existed)
          assert.equal(addPlugin(fs.readFileSync(file, "utf8"), dir, cfgDir).state, "ok")
        }
        say(dry ? "plan" : "done", `${verb} "${slash(dir)}" to "plugins" in ${file}${existed ? ` (backup: ${file}.bak-${dry ? "<time>" : stamp()})` : " (new file)"}`)
      }
    } catch (e) {
      fail(`can't edit ${file} safely (${e.message}). Add this by hand: "plugins": ["${slash(dir)}"]`)
    }
  }

  if (wantCodex) {
    const file = path.join(home, ".codex", "hooks.json")
    const existed = fs.existsSync(file)
    if (!existed && !fs.existsSync(path.dirname(file)) && !args.includes("--codex-only")) {
      say("skip", `Codex not found (no ${path.dirname(file)}); run setup again after installing Codex`)
    } else {
      try {
        const text = existed ? fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "") : ""
        const r = mergeHooks(text.trim() ? JSON.parse(text) : {}, path.join(dir, "codex-hook.js"))
        for (const o of r.other) {
          say("warn", `${file} already has a ${o.event} hook running ${o.path}. Left unchanged; edit it by hand to use ${path.join(dir, "codex-hook.js")}.`)
        }
        if (r.added.length) {
          changed = hooksAdded = true
          if (!dry) {
            write(file, dump(r.json, text), existed)
            assert.deepEqual(mergeHooks(JSON.parse(fs.readFileSync(file, "utf8")), path.join(dir, "codex-hook.js")).added, [])
          }
          say(dry ? "plan" : "done", `${verb} Codex hooks ${r.added.join(", ")} in ${file}${existed ? ` (backup: ${file}.bak-${dry ? "<time>" : stamp()})` : " (new file)"}`)
        }
        if (r.same.length) say("ok", `Codex hooks already configured: ${r.same.join(", ")} (${file})`)
      } catch (e) {
        fail(`can't edit ${file} safely (${e.message})`)
      }
    }
  }

  if (!changed && !failed) console.log("Nothing to change.")
  else if (changed && !dry) {
    console.log("\nStill to do by hand:")
    if (hooksAdded) console.log("  - Codex: run `codex`, type /hooks, and trust the three new hooks (untrusted hooks are skipped).")
    if (pluginAdded) console.log("  - OpenCode: restart it (`opencode service restart`, or quit and reopen the desktop app).")
  }
  return failed ? 1 : 0
}

if (process.argv[1] && norm(fs.realpathSync(process.argv[1])) === norm(fs.realpathSync(fileURLToPath(import.meta.url)))) {
  process.exitCode = main(process.argv.slice(2))
}
