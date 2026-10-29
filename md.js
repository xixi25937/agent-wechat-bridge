// WeChat shows bot text as Markdown: a single "\n" is a space, a blank line starts a paragraph, and "- " lines are a
// compact bullet list. Every message the bridge composes goes through these; text an agent wrote is never touched.

// Paragraphs, one blank line apart; empty ones (false, "", undefined) are skipped.
export const md = (...parts) => parts.filter(Boolean).join("\n\n")

// One "- " line per item (an item never spans lines).
export const ul = (items) => items.map((s) => `- ${String(s).replace(/\s*\n\s*/g, " ")}`).join("\n")

// Items with their numbers visible: "- 1 浅色". "1. x" would be an ordered list, which isn't known to render.
export const numbered = (items) => ul(items.map((s, i) => `${i + 1} ${s}`))

// Single "\n" breaks outside bullet lists (they would show as spaces); [] when `text` is laid out right.
export const looseBreaks = (text) =>
  String(text)
    .split(/\n{2,}/)
    .filter((p) => p.includes("\n") && !p.split("\n").every((l) => l.startsWith("- ")))
