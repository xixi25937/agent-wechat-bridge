import crypto from "node:crypto"
import net from "node:net"
import { frame, unframe } from "./codex.js"

// A stand-in for the desktop router + owner window on a private pipe.
export function fakeDesktop({ owns, requests, onRequest }) {
  const pipe = `\\\\.\\pipe\\wx-test-${crypto.randomBytes(4).toString("hex")}`
  const got = []
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0)
    const send = (o) => sock.write(frame(o))
    sock.on("data", (d) => {
      const r = unframe(Buffer.concat([buf, d]))
      buf = r.rest
      for (const m of r.msgs) {
        got.push(m)
        const reply = (extra) => send({ type: "response", requestId: m.requestId, method: m.method, ...extra })
        if (m.type === "broadcast" && m.method === "thread-stream-following-changed" && m.params.following)
          send({ type: "broadcast", method: "thread-stream-state-changed", version: 11, params: { conversationId: m.params.conversationId, hostId: "local", change: { type: "snapshot", revision: 1, conversationState: { requests } } } })
        if (m.type !== "request") continue
        if (m.method === "initialize") reply({ resultType: "success", handledByClientId: "me", result: { clientId: "me" } })
        else if (m.method === "thread-owner-discovery") reply(owns ? { resultType: "success", handledByClientId: "owner", result: {} } : { resultType: "error", error: "no-client-found" })
        else reply(onRequest?.(m) ?? { resultType: "success", handledByClientId: "owner", result: { ok: true, ...(m.method === "thread-follower-interrupt-turn" && { interruptedTurnId: "turn-9" }) } })
      }
    })
  })
  return new Promise((r) => server.listen(pipe, () => r({ pipe, got, close: () => server.close() })))
}
