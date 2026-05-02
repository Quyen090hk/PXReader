"use strict";

const indexes = new Map();

self.addEventListener("message", (event) => {
  const { id, type, payload } = event.data || {};
  try {
    if (type === "build") {
      const result = buildIndex(payload.bookId, payload.units || []);
      reply(id, true, result);
      return;
    }

    if (type === "search") {
      const result = searchIndex(payload.bookId, payload.query || "");
      reply(id, true, result);
      return;
    }

    throw new Error(`Unknown worker request: ${type}`);
  } catch (error) {
    reply(id, false, null, error.message || String(error));
  }
});

function buildIndex(bookId, rawUnits) {
  const units = rawUnits.map((unit, index) => ({
    id: unit.id || String(index),
    title: unit.title || `Unit ${index + 1}`,
    text: String(unit.text || ""),
    lowerText: String(unit.text || "").toLocaleLowerCase(),
    location: unit.location,
  }));

  const inverted = new Map();
  for (let index = 0; index < units.length; index += 1) {
    const tokens = new Set(tokenize(units[index].text));
    for (const token of tokens) {
      if (!inverted.has(token)) inverted.set(token, []);
      inverted.get(token).push(index);
    }
  }

  indexes.set(bookId, { units, inverted });
  return {
    unitCount: units.length,
    termCount: inverted.size,
  };
}

function searchIndex(bookId, query) {
  const index = indexes.get(bookId);
  if (!index) return [];

  const needle = String(query || "").trim().toLocaleLowerCase();
  if (!needle) return [];

  const tokens = tokenize(needle);
  const candidates = candidateUnits(index, tokens);
  const results = [];

  for (const unitIndex of candidates) {
    const unit = index.units[unitIndex];
    let from = 0;
    while (results.length < 200) {
      const hit = unit.lowerText.indexOf(needle, from);
      if (hit < 0) break;
      results.push({
        title: unit.title,
        snippet: createSnippet(unit.text, hit, needle.length),
        location: unit.location,
      });
      from = hit + Math.max(needle.length, 1);
    }
    if (results.length >= 200) break;
  }

  return results;
}

function candidateUnits(index, tokens) {
  if (!tokens.length) {
    return index.units.map((_, unitIndex) => unitIndex);
  }

  const lists = tokens
    .map((token) => index.inverted.get(token) || [])
    .filter((list) => list.length > 0)
    .sort((a, b) => a.length - b.length);

  if (!lists.length) return [];

  let candidates = new Set(lists[0]);
  for (const list of lists.slice(1)) {
    const next = new Set(list);
    candidates = new Set([...candidates].filter((unitIndex) => next.has(unitIndex)));
    if (!candidates.size) break;
  }

  return [...candidates].sort((a, b) => a - b);
}

function tokenize(value) {
  const text = String(value || "").toLocaleLowerCase();
  const tokens = [];
  const latin = text.match(/[\p{L}\p{N}_]{2,}/gu) || [];
  tokens.push(...latin);

  const cjk = text.match(/[\u3400-\u9fff]/gu) || [];
  for (const char of cjk) tokens.push(char);
  for (let index = 0; index < cjk.length - 1; index += 1) {
    tokens.push(cjk[index] + cjk[index + 1]);
  }

  return [...new Set(tokens)];
}

function createSnippet(text, index, length) {
  const start = Math.max(0, index - 42);
  const end = Math.min(text.length, index + length + 58);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${collapseWhitespace(text.slice(start, end))}${suffix}`;
}

function collapseWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function reply(id, ok, result, error) {
  self.postMessage({ id, ok, result, error });
}
