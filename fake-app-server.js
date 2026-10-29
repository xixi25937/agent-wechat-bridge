// Stand-in for `codex app-server` in codex.test.js: one turn asks a question, then an approval, then completes.
import readline from "node:readline"

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n")
const waiting = new Map()
let sid = 1000
const ask = (method, params) => new Promise((r) => (waiting.set(++sid, r), out({ id: sid, method, params })))

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line)
  if (m.method == null) return waiting.get(m.id)?.(m)
  const ok = (result) => out({ id: m.id, result })
  const p = m.params ?? {}
  switch (m.method) {
    case "initialize":
      return ok({ userAgent: "fake" })
    case "thread/resume":
      return p.threadId === "busy" ? out({ id: m.id, error: { code: -32600, message: "thread busy already has a live local writer" } }) : ok({ thread: { id: p.threadId } })
    case "thread/start":
      return ok({ thread: { id: "new-thread" } })
    case "turn/start": {
      ok({ turn: { id: "turn1", status: "inProgress", items: [] } })
      const threadId = p.threadId
      const q = await ask("item/tool/requestUserInput", { threadId, turnId: "turn1", itemId: "i1", questions: [{ id: "q", question: "选哪个？", options: [{ label: "A" }] }] })
      if (q.result?.answers?.q?.answers?.[0] !== "A") return
      const a = await ask("item/commandExecution/requestApproval", { threadId, turnId: "turn1", itemId: "i2", command: "git push", reason: "推送" })
      out({ method: "serverRequest/resolved", params: { threadId, requestId: sid } })
      out({ method: "item/completed", params: { threadId, turnId: "turn1", item: { type: "agentMessage", id: "m1", text: "好的" } } })
      return out({ method: "turn/completed", params: { threadId, turn: { id: "turn1", status: a.result?.decision === "accept" ? "completed" : "failed", items: [] } } })
    }
    default:
      return ok({})
  }
})
