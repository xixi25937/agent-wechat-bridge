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
  const woke = { ...me, trustStale: false }
  assert.equal(canTake({ pid: 11, host: "h", beat: 1 }, { ...woke, alive: live }), false, "just woke: an old beat of a live pid is not enough")
  assert.equal(canTake({ pid: 11, host: "h", beat: 1 }, { ...woke, alive: dead }), true, "just woke, holder pid gone")
  assert.equal(canTake({ pid: 11, host: "other", beat: 1 }, { ...woke, alive: dead }), false, "just woke, other host")
})

const nap = (ms) => new Promise((r) => setTimeout(r, ms))

test("a retry that fires late (the machine slept) does not take a live holder's lock for its old beat", async () => {
  const dir = tmp()
  const holder = { pid: 4242, host: os.hostname() }
  const put = (age) => fs.writeFileSync(lockFile(dir), JSON.stringify({ ...holder, beat: Date.now() - age }))
  const contender = (ev) => pollLock(dir, { standbyMs: 40, staleMs: 1000, lateMs: 60, alive: () => true, onHeld: () => ev.push("held") })
  const sleep = () => {
    put(5000) // the holder's beat went old while everything slept
    for (const end = Date.now() + 250; Date.now() < end; ); // our retry was due in 40 ms and fires 250 ms late
  }
  try {
    // The holder renews as soon as it wakes: never taken.
    const a = []
    const l = contender(a)
    put(0)
    l.start()
    sleep()
    await nap(10)
    put(0)
    await nap(200)
    assert.deepEqual(a, [], "alive and beating")
    l.stop()
    // Nobody renews (a hung holder): taken, one round later.
    const b = []
    const l2 = contender(b)
    put(0)
    l2.start()
    sleep()
    await nap(10)
    assert.deepEqual(b, [], "the late retry doesn't judge the old beat")
    for (let i = 0; i < 100 && !b.length; i++) await nap(10)
    assert.deepEqual(b, ["held"], "the next retry does")
    l2.stop()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("wake() renews the beat at once, and reports a lock that is gone", () => {
  const dir = tmp()
  try {
    const ev = []
    const l = pollLock(dir, { beatMs: 60_000, onLost: () => ev.push("lost") })
    l.start()
    fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: process.pid, host: os.hostname(), beat: Date.now() - 600_000 }))
    l.wake()
    assert.ok(Date.now() - readLock(dir).beat < 5000, "renewed")
    fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: process.pid + 1, host: "elsewhere", beat: Date.now() }))
    l.wake()
    assert.deepEqual(ev, ["lost"])
    l.stop()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
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
    fs.rmSync(lockFile(dir))
    const l2 = pollLock(dir, { onHeld: () => ev.push("held2") })
    l2.start()
    l2.stop(true)
    assert.equal(readLock(dir).pid, process.pid, "stop(true) keeps the file for a reloaded successor")
    const l3 = pollLock(dir, { onHeld: () => ev.push("held3") })
    l3.start()
    assert.deepEqual(ev.slice(2), ["held2", "held3"], "same pid takes its own lock again")
    l3.stop()
    assert.equal(fs.existsSync(lockFile(dir)), false, "stop() releases")
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

// index.js wiring: which processes take the lock. No account.json in the temp dir, so a poller that starts only logs an error.
test("index.js takes poll.lock only when eligible", async () => {
  const dir = tmp()
  const url = pathToFileURL(path.join(import.meta.dirname, "index.js")).href
  const code = `import fs from "node:fs"
    const m = await import(${JSON.stringify(url)})
    const ctx = { event: { subscribe: async function* () { await new Promise(() => {}) } } }
    const stop = m.default.setup(ctx)
    await new Promise((r) => setTimeout(r, 300))
    const file = process.env.WECHAT_NOTIFY_DIR + "/poll.lock"
    const held = fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).pid === process.pid
    stop()
    console.log(JSON.stringify({ held, releasedOnDispose: !fs.existsSync(file) }))
    process.exit(0)`
  const run = (poll, ...argv) =>
    new Promise((resolve) => {
      const env = { ...process.env, WECHAT_NOTIFY_DIR: dir }
      delete env.WECHAT_NOTIFY_POLL
      if (poll != null) env.WECHAT_NOTIFY_POLL = poll
      const p = spawn(process.execPath, ["--input-type=module", "-e", code, "--", ...argv], { env, stdio: ["ignore", "pipe", "ignore"] })
      let out = ""
      p.stdout.on("data", (d) => (out += d))
      p.on("close", () => resolve(JSON.parse(out.trim().split("\n").pop())))
    })
  try {
    assert.equal((await run(null)).held, false, "default: not eligible")
    assert.equal((await run("0", "--service")).held, false, "=0 never polls, even with --service")
    assert.equal((await run(null, "--service")).held, true, "--service is eligible")
    assert.deepEqual(await run("1"), { held: true, releasedOnDispose: true }, "=1 is eligible anywhere; dispose releases")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("three processes: exactly one holds the lock, and another takes over when it is killed", async () => {
  const dir = tmp()
  const lockUrl = pathToFileURL(path.resolve("poll-lock.js")).href
  // Each child reports "held" / "lost" on stdout; short intervals keep the test fast.
  const code = `import { pollLock } from ${JSON.stringify(lockUrl)}
    const l = pollLock(process.argv[1], { beatMs: 150, staleMs: 1500, standbyMs: 200,
      onHeld: () => console.log("held"), onLost: () => console.log("lost") })
    l.start(); setInterval(() => {}, 1000)`
  const kids = [0, 1, 2].map(() => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", code, dir], { stdio: ["ignore", "pipe", "inherit"] })
    p.held = false
    p.stdout.on("data", (d) => {
      for (const w of String(d).split(/\s+/)) if (w === "held") p.held = true
      else if (w === "lost") p.held = false
    })
    return p
  })
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const holders = () => kids.filter((k) => k.exitCode === null && !k.killed && k.held)
  try {
    for (let i = 0; i < 50 && holders().length !== 1; i++) await wait(100)
    assert.equal(holders().length, 1, "one holder")
    for (let i = 0; i < 10; i++) (await wait(100), assert.ok(holders().length <= 1, "never two"))
    const first = holders()[0]
    first.kill("SIGKILL") // no cleanup: the others must notice the dead pid
    for (let i = 0; i < 60 && holders().length !== 1; i++) await wait(100)
    assert.equal(holders().length, 1, "taken over")
    assert.notEqual(holders()[0], first)
    // A heartbeat rewrites the file in place, so a read can land on it empty (pid 0); read again.
    let l = readLock(dir)
    for (let i = 0; i < 20 && !l?.pid; i++) (await wait(50), (l = readLock(dir)))
    assert.equal(l.pid, holders()[0].pid)
  } finally {
    for (const k of kids) k.kill("SIGKILL")
    await wait(200)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
