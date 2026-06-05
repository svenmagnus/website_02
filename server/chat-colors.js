export function chatColorsFromRow(row) {
  if (!row?.chat_colors_json) return null;
  try {
    const parsed = JSON.parse(row.chat_colors_json);
    if (!parsed || typeof parsed !== "object") return null;
    const name = String(parsed.name || "").trim();
    const text = String(parsed.text || "").trim();
    if (!name && !text) return null;
    return { name, text };
  } catch (_) {
    return null;
  }
}

export function normalizeChatColorsInput(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name || "").trim().slice(0, 32);
  const text = String(raw.text || "").trim().slice(0, 32);
  if (!name && !text) return null;
  return { name, text };
}
