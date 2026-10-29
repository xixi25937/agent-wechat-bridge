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
    case "thread/revert":
      return p.beforeTurnId === "turn1" ? ok({ thread: { id: p.threadId, turns: [] } }) : out({ id: m.id, error: { code: -32600, message: "unknown turn" } })
    case "model/list":
      return ok({ data: [{ id: "m1", model: "m1", displayName: "M1", hidden: false, inputModalities: ["text", "image"] }], nextCursor: null })
    case "thread/compact/start":
      ok({})
      return out({ method: "turn/completed", params: { threadId: p.threadId, turn: { id: "c1", status: "completed", items: [] } } })
    case "turn/interrupt":
      ok({})
      return out({ method: "turn/completed", params: { threadId: p.threadId, turn: { id: p.turnId, status: "interrupted", items: [] } } })
    case "turn/start": {
      ok({ turn: { id: "turn1", status: "inProgress", items: [] } })
      const threadId = p.threadId
      // "echo" replies with the input and model it got; "slow" runs until interrupted.
      if (threadId === "slow") return
      if (threadId === "echo") {
        out({ method: "item/completed", params: { threadId, item: { type: "agentMessage", text: JSON.stringify({ input: p.input, model: p.model }) } } })
        return out({ method: "turn/completed", params: { threadId, turn: { id: "turn1", status: "completed", items: [] } } })
      }
      const questions = [
        { id: "q", header: "选项", question: "选哪个？", isOther: false, options: [{ label: "A", description: "" }, { label: "B", description: "" }] },
        { id: "pw", header: "密码", question: "", isOther: false, isSecret: true, options: null },
      ]
      const q = await ask("item/tool/requestUserInput", { threadId, turnId: "turn1", itemId: "i1", isBlocking: true, questions })
      if (JSON.stringify(q.result) !== JSON.stringify({ answers: { q: { answers: ["A"] }, pw: { answers: ["hunter2"] } } })) return
      const a = await ask("item/commandExecution/requestApproval", { threadId, turnId: "turn1", itemId: "i2", command: "git push", reason: "推送" })
      out({ method: "serverRequest/resolved", params: { threadId, requestId: sid } })
      out({ method: "item/completed", params: { threadId, turnId: "turn1", item: { type: "agentMessage", id: "m1", text: "好的" } } })
      return out({ method: "turn/completed", params: { threadId, turn: { id: "turn1", status: a.result?.decision === "accept" ? "completed" : "failed", items: [] } } })
    }
    default:
      return ok({})
  }
})
