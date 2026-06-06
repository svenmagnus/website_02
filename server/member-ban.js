export function isUserBanned(row) {
  return Boolean(row?.banned_at);
}

export function banFieldsForProfile(row) {
  return {
    isBanned: isUserBanned(row),
    banReason: String(row?.ban_reason || "").trim(),
    bannedAt: row?.banned_at || null,
  };
}

export function normalizeBanReasonInput(raw) {
  if (raw == null) return "";
  return String(raw).trim().slice(0, 500);
}
