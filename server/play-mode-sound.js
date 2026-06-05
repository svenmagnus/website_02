export function playModeSoundFromRow(row) {
  const id = String(row?.play_mode_sound || "").trim().slice(0, 32);
  return id || null;
}

export function normalizePlayModeSoundInput(raw) {
  const id = String(raw || "").trim().slice(0, 32);
  return id || null;
}
