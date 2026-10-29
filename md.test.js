import assert from "node:assert/strict"
import { test } from "node:test"
import { looseBreaks, md, numbered, ul } from "./md.js"

test("md, ul, numbered", () => {
  assert.equal(md("a", "", false, undefined, "b\nc"), "a\n\nb\nc", "paragraphs a blank line apart; empty ones are skipped")
  assert.equal(md(), "")
  assert.equal(ul(["x", "y\nz"]), "- x\n- y z", "an item never spans lines")
  assert.equal(numbered(["红", "蓝"]), "- 1 红\n- 2 蓝")
})

test("looseBreaks finds single line breaks outside bullet lists", () => {
  assert.deepEqual(looseBreaks(md("标题", ul(["a", "b"]), "尾")), [])
  assert.deepEqual(looseBreaks("a\n\nb"), [])
  assert.deepEqual(looseBreaks("a\nb"), ["a\nb"])
  assert.deepEqual(looseBreaks("标题\n- a\n- b"), ["标题\n- a\n- b"], "a list needs its blank line above")
  assert.deepEqual(looseBreaks("- a\n  续行"), ["- a\n  续行"])
})
