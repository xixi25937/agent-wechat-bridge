// Cross-process lock so only one process long-polls WeChat. State dir holds poll.lock = {pid, host, beat}. Node stdlib only.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const BEAT_MS = 15_000
export const STALE_MS = 60_000
export const STANDBY_MS = 30_000
// An empty or half-written lock (creator between open and write) counts as held until its mtime is this old.
const GUARD_STALE_MS = 10_000

export const pidAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === "EPERM"
  }
}

// Pure decision. lock = parsed poll.lock, null when missing. The pid check only means something on the same host.
export function canTake(lock, { pid = process.pid, host = os.hostname(), now = Date.now(), staleMs = STALE_MS, alive = pidAlive } = {}) {
  if (!lock) return true
  if (lock.pid === pid && lock.host === host) return true
  if (!(now - lock.beat <= staleMs)) return true
  return lock.host === host && !alive(lock.pid)
}

export const lockFile = (dir) => path.join(dir, "poll.lock")
const body = (o) => JSON.stringify({ pid: o.pid ?? process.pid, host: o.host ?? os.hostname(), beat: Date.now() })

export function readLock(dir) {
  const file = lockFile(dir)
  let text
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return null
  }
  try {
    const l = JSON.parse(text)
    if (Number.isInteger(l?.pid) && typeof l.beat === "number") return l
  } catch {}
  try {
    return { pid: 0, host: "", beat: fs.statSync(file).mtimeMs }
  } catch {
    return null
  }
}

const create = (file, text = "") => {
  let fd
  try {
    fd = fs.openSync(file, "wx")
  } catch (e) {
    if (e.code === "EEXIST") return false
    throw e
  }
  try {
    fs.writeSync(fd, text)
  } finally {
    fs.closeSync(fd)
  }
  return true
}

const mine = (l, o) => l?.pid === (o.pid ?? process.pid) && l.host === (o.host ?? os.hostname())

export function acquire(dir, o = {}) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const file = lockFile(dir)
    if (create(file, body(o))) return true
    const l = readLock(dir)
    if (mine(l, o)) return (fs.writeFileSync(file, body(o)), true)
    if (!canTake(l, o)) return false
    // Taking over a dead holder: removing it and creating ours is two steps, so contenders go through a guard file.
    const guard = `${file}.take`
    if (!create(guard)) {
      try {
        if (Date.now() - fs.statSync(guard).mtimeMs > GUARD_STALE_MS) fs.rmSync(guard, { force: true })
      } catch {}
      return false
    }
    try {
      if (!canTake(readLock(dir), o)) return false
      fs.rmSync(file, { force: true })
      return create(file, body(o))
    } finally {
      fs.rmSync(guard, { force: true })
    }
  } catch {
    return false
  }
}

// false = the lock is no longer ours.
export function beat(dir, o = {}) {
  if (!mine(readLock(dir), o)) return false
  try {
    fs.writeFileSync(lockFile(dir), body(o))
  } catch {}
  return true
}

export function release(dir, o = {}) {
  try {
    if (mine(readLock(dir), o)) fs.rmSync(lockFile(dir), { force: true })
  } catch {}
}

// Tries to hold the lock; while someone else does it retries every standbyMs, and while it holds it beats every beatMs.
// onHeld / onLost run on each change. stop() releases. Timers are unref'd, so this never keeps a process alive.
export function pollLock(dir, { onHeld, onLost, beatMs = BEAT_MS, staleMs = STALE_MS, standbyMs = STANDBY_MS, alive } = {}) {
  const o = { staleMs, alive }
  let held = false
  let timer
  let stopped = false
  const bye = () => release(dir, o)
  const sigs = ["SIGINT", "SIGTERM"].map((sig) => {
    // Re-raise only when nobody else handles the signal; otherwise their exit fires "exit" below.
    const fn = () => (bye(), process.removeListener(sig, fn), process.kill(process.pid, sig))
    return [sig, fn]
  })
  const tick = () => {
    if (held && !beat(dir, o)) {
      held = false
      onLost?.()
    }
    if (!held && acquire(dir, o)) {
      held = true
      onHeld?.()
    }
    if (!stopped) (timer = setTimeout(tick, held ? beatMs : standbyMs)).unref()
  }
  return {
    held: () => held,
    start() {
      process.on("exit", bye)
      for (const [sig, fn] of sigs) if (!process.listenerCount(sig)) process.on(sig, fn)
      tick()
    },
    stop() {
      stopped = true
      clearTimeout(timer)
      process.removeListener("exit", bye)
      for (const [sig, fn] of sigs) process.removeListener(sig, fn)
      if (held) (held = false, bye())
    },
  }
}
