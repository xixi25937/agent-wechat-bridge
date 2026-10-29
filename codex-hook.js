// Codex hook: `node codex-hook.js Stop|PermissionRequest`, payload JSON on stdin (see README).
// Must never break Codex: every failure exits 0 with no decision and one stderr line.
import { spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { bridgeMarker, cleanDir, codexHead, desktopOwns } from "./codex.js"

export { codexHead }

// Terminal (TUI / exec) only: seconds to wait for a WeChat answer before Codex shows its own prompt.
// The desktop and turns started from WeChat never wait: their approvals are answered through the live process.
const WAIT_S = Math.min(Number(process.env.CODEX_WECHAT_APPROVAL_TIMEOUT) || 60, 590)
const NO_TEXT = "完成（没有文字回复）"

// Thread row from Codex's state db, or null (old Node, db locked or missing, thread not written yet).
export async function threadInfo(id, db = path.join(process.env.CODEX_HOME || path.join(process.env.USERPROFILE || process.env.HOME || "", ".codex"), "state_5.sqlite")) {
  try {
    const { DatabaseSync } = await import("node:sqlite")
    const conn = new DatabaseSync(db, { readOnly: true })
    try {
      return conn.prepare("select name, title, cwd, source, thread_source from threads where id = ?").get(id) ?? null
    } finally {
      conn.close()
    }
  } catch {
    return null
  }
}

export const isSubagent = (t) => /^(subagent|guardian_review)$/.test(t?.thread_source ?? "") || /"subagent"/.test(t?.source ?? "")

// What the approval is for: the shell command, the files an apply_patch touches, or the MCP tool and its arguments.
export function permissionSummary(p, short) {
  const input = p?.tool_input ?? {}
  const cmd = typeof input.command === "string" ? input.command : Array.isArray(input.command) ? input.command.join(" ") : ""
  if (p?.tool_name === "apply_patch") {
    const files = [...cmd.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)].map((m) => `${{ Add: "新建", Update: "修改", Delete: "删除" }[m[1]]} ${m[2].trim()}`)
    return short(`改文件：${files.join("，") || cmd}`, 300)
  }
  const { description, ...args } = input
  const what = cmd || (Object.keys(args).length ? JSON.stringify(args) : "")
  return short([p?.tool_name !== "Bash" && p?.tool_name, what, description && `（${description}）`].filter(Boolean).join(" "), 300)
}

// stdout for a PermissionRequest answer; "" means no decision, so Codex shows its normal prompt.
export function decisionOutput(answer) {
  if (answer !== "allow" && answer !== "deny") return ""
  const decision = answer === "allow" ? { behavior: "allow" } : { behavior: "deny", message: "用户在微信里拒绝了" }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } })
}

const alive = (pid) => {
  try {
    return !!pid && (process.kill(pid, 0), true)
  } catch (e) {
    return e.code === "EPERM"
  }
}

async function onStop(p, m) {
  const thread = await threadInfo(p.session_id)
  if (isSubagent(thread)) return
  const key = `codex:${p.session_id}`
  const n = m.numOf(key)
  const reply = p.last_assistant_message ?? ""
  const { files, big } = await m.replyImages(reply, cleanDir(p.cwd))
  let text = `${codexHead(n, p.cwd, thread, m)}\n${m.clip(reply, n) || NO_TEXT}`
  if (big.length) text += `\n（图片太大没发：${big.join("、")}）`
  m.update((s) => (s.last = key))
  console.error(`${new Date().toISOString()} Stop [${n}] ${await m.send(text)}`)
  for (const f of files) await m.sendImage(f).catch((e) => console.error("[codex-hook] image:", m.short(e?.message, 150)))
}

// Who answers a WeChat 「N y」: "bridge" (a turn the plugin runs), "desktop" (the window has the thread loaded), or
// "wait" (a terminal: no channel reaches the TUI, so this hook waits briefly for the answer file).
export async function approvalMode(threadId, pendingDir, owns = desktopOwns) {
  // Bridge turns push and answer their own approvals (see createBridge in codex.js).
  if (fs.existsSync(bridgeMarker(pendingDir, threadId))) return "bridge"
  return (await owns(threadId).catch(() => false)) ? "desktop" : "wait"
}

export async function onPermission(p, m, { waitS = WAIT_S, mode } = {}) {
  const thread = await threadInfo(p.session_id)
  const key = `codex:${p.session_id}`
  const n = m.numOf(key)
  const listening = alive(m.state().pollerPid)
  const how = listening ? (mode ?? (await approvalMode(p.session_id, m.PENDING_DIR))) : null
  if (how === "bridge") return ""
  const tail = !listening
    ? "（OpenCode 后台服务没在运行，微信回复收不到，请在电脑上处理）"
    : how === "wait"
      ? `回复「${n} y」批准，「${n} n」拒绝（${waitS} 秒内没回复就在电脑上处理）`
      : `回复「${n} y」批准，「${n} n」拒绝（电脑上也可以直接点）`
  m.update((s) => (s.last = key))
  const summary = permissionSummary(p, m.short)
  const sent = await m.send(`${codexHead(n, p.cwd, thread, m)}\n等你批准：${summary}\n${tail}`)
  if (!listening || sent === "error") return ""
  fs.mkdirSync(m.PENDING_DIR, { recursive: true })
  const id = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
  const req = path.join(m.PENDING_DIR, `${id}.json`)
  const ans = path.join(m.PENDING_DIR, `${id}.answer`)
  const record = { id, n, threadId: p.session_id, mode: how, pid: process.pid, summary, created: Date.now() }
  fs.writeFileSync(req, JSON.stringify(record))
  // No decision: Codex shows its normal prompt; the plugin answers it through the desktop or its own app-server.
  if (how !== "wait") return ""
  let answered = false
  try {
    for (const end = Date.now() + waitS * 1000; Date.now() < end; ) {
      const a = fs.existsSync(ans) && fs.readFileSync(ans, "utf-8").trim()
      if (a) return (answered = true), decisionOutput(a)
      await new Promise((r) => setTimeout(r, Math.min(500, waitS * 1000)))
    }
    return ""
  } finally {
    fs.rmSync(ans, { force: true })
    // Timed out: keep the record as done, so a late 「N y」 gets 「已经在电脑上处理了」.
    if (answered) fs.rmSync(req, { force: true })
    else fs.writeFileSync(req, JSON.stringify({ ...record, done: Date.now() }))
  }
}

async function main() {
  let out = ""
  try {
    const event = process.argv[2]
    let raw = ""
    if (event === "stop-send") {
      // Detached child of a Stop hook: the payload file is ours to read and delete.
      raw = fs.readFileSync(process.argv[3], "utf-8")
      fs.rmSync(process.argv[3], { force: true })
    } else for await (const c of process.stdin) raw += c
    const p = JSON.parse(raw || "{}")
    if (event === "stop-send") await onStop(p, await import("./index.js"))
    else if ((event || p.hook_event_name) === "Stop") {
      // A turn started from WeChat: the plugin pushes the reply itself. Checked here, before the turn ends.
      const { PENDING_DIR } = await import("./index.js")
      if (fs.existsSync(bridgeMarker(PENDING_DIR, p.session_id))) return process.exit(0)
      // Codex waits for Stop hooks before ending the turn, so send from a detached process and return at once.
      const file = path.join(os.tmpdir(), `codex-wechat-stop-${process.pid}-${Date.now()}.json`)
      fs.writeFileSync(file, raw)
      const { DIR } = await import("./index.js")
      const errLog = fs.openSync(path.join(DIR, "codex-hook.log"), "a")
      spawn(process.execPath, [fileURLToPath(import.meta.url), "stop-send", file], { detached: true, stdio: ["ignore", "ignore", errLog], windowsHide: true }).unref()
    } else if ((event || p.hook_event_name) === "PermissionRequest") out = await onPermission(p, await import("./index.js"))
  } catch (e) {
    console.error("[codex-hook]", String(e?.message ?? e).slice(0, 200))
  }
  // Exit explicitly: fetch keep-alive sockets would otherwise hold the hook open for a few seconds.
  process.stdout.write(out, () => process.exit(0))
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main()
