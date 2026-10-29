import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"
import { acquire, beat, canTake, lockFile, pollLock, readLock, release } from "./poll-lock.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "awb-lock-"))

test("canTake decides on pid, host and heartbeat", () => {
  const me = { pid: 10, host: "h", now: 100_000, staleMs: 60_000 }
  const dead = () => false
  const live = () => true
  assert.equal(canTake(null, me), true, "no lock")
  assert.equal(canTake({ pid: 10, host: "h", beat: 99_000 }, { ...me, alive: dead }), true, "our own (hot reload)")
  assert.equal(canTake({ pid: 11, host: "h", beat: 99_000 }, { ...me, alive: live }), false, "live holder, fresh beat")
  assert.equal(canTake({ pid: 11, host: "h", beat: 99_000 }, { ...me, alive: dead }), true, "holder pid gone")
  assert.equal(canTake({ pid: 11, host: "h", beat: 39_000 }, { ...me, alive: live }), true, "beat older than 60 s")
  assert.equal(canTake({ pid: 11, host: "h", beat: 40_000 }, { ...me, alive: live }), false, "exactly 60 s is still fresh")
  assert.equal(canTake({ pid: 11, host: "other", beat: 99_000 }, { ...me, alive: dead }), false, "other host: pid means nothing")
  assert.equal(canTake({ pid: 11, host: "other", beat: 1 }, { ...me, alive: dead }), true, "other host, stale")
})

test("acquire, beat, release", () => {
  const dir = tmp()
  try {
    const a = { pid: 1001, host: "h", alive: () => true }
    const b = { pid: 1002, host: "h", alive: () => true }
    assert.equal(acquire(dir, a), true)
    assert.equal(acquire(dir, b), false)
    assert.equal(acquire(dir, a), true, "same pid re-acquires")
    assert.equal(beat(dir, b), false)
    release(dir, b)
    assert.equal(readLock(dir).pid, 1001, "release by a non-owner does nothing")
    const t0 = readLock(dir).beat
    fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: 1001, host: "h", beat: t0 - 5000 }))
    assert.equal(beat(dir, a), true)
    assert.ok(readLock(dir).beat > t0 - 5000)
    release(dir, a)
    assert.equal(fs.existsSync(lockFile(dir)), false)
    fs.writeFileSync(lockFile(dir), "")
    assert.equal(acquire(dir, a), false, "a lock caught mid-write is held")
    const old = new Date(Date.now() - 120_000)
    fs.utimesSync(lockFile(dir), old, old)
    assert.equal(acquire(dir, { ...a, staleMs: 60_000 }), true, "an old unreadable lock is stale")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("pollLock reports held/lost and releases on stop", async () => {
  const dir = tmp()
  try {
    const ev = []
    const l = pollLock(dir, { beatMs: 20, standbyMs: 20, onHeld: () => ev.push("held"), onLost: () => ev.push("lost") })
    l.start()
    assert.deepEqual(ev, ["held"])
    assert.equal(readLock(dir).pid, process.pid)
    fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: process.pid + 1, host: "elsewhere", beat: Date.now() }))
    await new Promise((r) => setTimeout(r, 100))
    assert.deepEqual(ev, ["held", "lost"])
    l.stop()
    assert.equal(readLock(dir).pid, process.pid + 1, "stop leaves someone else's lock")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// Three real processes: one wins, and when it dies another takes over. alive=false uses the pid check; alive=true
// pretends every pid lives, so the takeover has to wait for the heartbeat to go stale.
for (const ignorePid of [false, true]) {
  test(`3 processes, one holder, takeover after kill (${ignorePid ? "stale heartbeat" : "dead pid"})`, async () => {
    const dir = tmp()
    const url = pathToFileURL(path.join(import.meta.dirname, "poll-lock.js")).href
    const code = `import { pollLock } from ${JSON.stringify(url)}
      pollLock(${JSON.stringify(dir)}, { beatMs: 100, staleMs: 1000, standbyMs: 150,
        alive: ${ignorePid} ? () => true : undefined, onHeld: () => console.log("HELD") }).start()
      setInterval(() => {}, 1000)`
    const kids = [0, 1, 2].map(() => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] })
      p.held = false
      p.stdout.on("data", (d) => String(d).includes("HELD") && (p.held = true))
      return p
    })
    const until = async (fn, ms) => {
      for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (fn()) return true
      return false
    }
    try {
      assert.ok(await until(() => kids.some((k) => k.held), 10_000), "someone holds the lock")
      await new Promise((r) => setTimeout(r, 1500))
      assert.equal(kids.filter((k) => k.held).length, 1, "exactly one holder")
      const first = kids.find((k) => k.held)
      assert.equal(readLock(dir).pid, first.pid)
      first.kill("SIGKILL")
      first.held = false
      assert.ok(await until(() => kids.some((k) => k.held), 10_000), "another process takes over")
      await new Promise((r) => setTimeout(r, 500))
      const second = kids.filter((k) => k.held)
      assert.equal(second.length, 1)
      assert.equal(readLock(dir).pid, second[0].pid)
    } finally {
      kids.forEach((k) => k.kill("SIGKILL"))
      await new Promise((r) => setTimeout(r, 200))
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}
