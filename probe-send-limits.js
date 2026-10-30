#!/usr/bin/env node
// Sends ONE real WeChat message to probe iLink's single-message limit (`long`), or ONE sendmessage with two text items
// (`two`). Prints only the status (never a token). At most 3 real sends per machine (counted in the temp dir). Stop on
// any ret=-2 and read errmsg: "prepare failed" is the quota (send the bot any message, then run it again), "invalid
// arguments" is a rejected request (seen for two text items in one sendmessage).
//   node probe-send-limits.js long [chars]   default 4500 characters (12.4 KB of UTF-8 for this text)
//   node probe-send-limits.js two
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const DIR = process.env.WECHAT_NOTIFY_DIR || path.join(os.homedir(), ".cli-bridge")
const STATE = path.join(DIR, "opencode-wechat-notify.json")
const COUNT = path.join(os.tmpdir(), "opencode", "wechat-probe-sends.json")
const MAX_SENDS = 3
const read = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"))
  } catch {
    return null
  }
}

export function longText(chars = 4500) {
  const head = "[测试] 长文本，请看最后有没有「END」。"
  const lines = []
  for (let n = 1; ; n++) {
    lines.push(`- 第${String(n).padStart(3, "0")}行：山高水长，风清月明，天朗气清，花好月圆，人寿年丰，岁月静好，山河无恙，万事胜意。`)
    const body = `${head}\n\n${group(lines)}\n\n`
    if (body.length + 40 >= chars) break
  }
  const text = `${head}\n\n${group(lines)}\n\n`
  return `${text}【END：共 ${lines.length} 行，最后一行是第${String(lines.length).padStart(3, "0")}行】`
}

// Ten lines per paragraph, so it reads as short lists.
function group(lines) {
  const out = []
  for (let i = 0; i < lines.length; i += 10) out.push(lines.slice(i, i + 10).join("\n"))
  return out.join("\n\n")
}

async function main() {
  const mode = process.argv[2]
  if (mode !== "long" && mode !== "two") return console.log("usage: node probe-send-limits.js long [chars] | two")
  const done = read(COUNT)?.sends ?? 0
  if (done >= MAX_SENDS) return console.log(`refused: ${done} real sends already made (max ${MAX_SENDS})`)
  const account = read(path.join(DIR, "account.json"))
  const state = read(STATE) ?? {}
  const tokens = read(path.join(DIR, "context_tokens.json")) ?? {}
  const contextToken = state.contextToken ?? tokens[account?.userId] ?? Object.values(tokens).pop()
  if (!account?.token || !account?.baseUrl || !account?.userId || !contextToken) return console.log("credentials missing")

  const texts = mode === "long" ? [longText(Number(process.argv[3]) || 4500)] : ["[测试] 双条目：第一条（同一次 sendmessage 的第 1 个 item）", "[测试] 双条目：第二条（同一次 sendmessage 的第 2 个 item）"]
  const bytes = texts.map((t) => Buffer.byteLength(t))
  fs.mkdirSync(path.dirname(COUNT), { recursive: true })
  fs.writeFileSync(COUNT, JSON.stringify({ sends: done + 1 }))
  let r
  try {
    const res = await fetch(new URL("ilink/bot/sendmessage", account.baseUrl.replace(/\/?$/, "/")), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        "X-WECHAT-UIN": Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0))).toString("base64"),
        Authorization: `Bearer ${account.token.trim()}`,
      },
      body: JSON.stringify({
        msg: {
          from_user_id: "",
          to_user_id: account.userId,
          client_id: `opencode-wechat-notify:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
          message_type: 2,
          message_state: 2,
          item_list: texts.map((text) => ({ type: 1, text_item: { text } })),
          context_token: contextToken,
        },
        base_info: { channel_version: "0.3.0" },
      }),
      signal: AbortSignal.timeout(20_000),
    })
    let json = {}
    try {
      json = JSON.parse((await res.text()) || "{}")
    } catch {}
    r = { http: res.status, ret: Number(json.ret ?? 0), errcode: Number(json.errcode ?? 0), errmsg: String(json.errmsg ?? "").slice(0, 120) }
  } catch (e) {
    // Nothing reached iLink, so it doesn't count as a real send.
    fs.writeFileSync(COUNT, JSON.stringify({ sends: done }))
    return console.log(`network error: ${e?.name} ${e?.cause?.code ?? e?.message}`)
  }
  const ok = r.http === 200 && !r.ret && !r.errcode
  // Keep the bridge's shared count right: a success is one more bot message; only "prepare failed" means the allowance
  // is gone ("invalid arguments" is also ret=-2, seen for two items in one sendmessage).
  if (ok || (r.ret === -2 && /prepare failed/i.test(r.errmsg))) {
    const s = read(STATE) ?? {}
    s.sent = ok ? (s.sent ?? 0) + 1 : 10
    const tmp = `${STATE}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(s))
    fs.renameSync(tmp, STATE)
  }
  console.log(JSON.stringify({ mode, items: texts.length, chars: texts.map((t) => t.length), utf8Bytes: bytes, ...r, ok, realSendsMade: done + 1 }))
  if (r.ret === -2) console.log(`ret=-2 (${r.errmsg}). Stop all real sends and report; if it says "prepare failed" the user must send the bot a message to refresh the quota.`)
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) await main()
