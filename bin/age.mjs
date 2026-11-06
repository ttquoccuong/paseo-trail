// Shared by the MCP server and the reminder hook, which both run straight from the plugin checkout.

/** How long ago `iso` was, as 5m, 3h or 2d; null when unknown or in the future. */
export function age(iso, now = Date.now()) {
  const minutes = Math.floor((now - Date.parse(iso ?? "")) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  if (minutes < 60) return `${minutes}m`;
  return minutes < 48 * 60 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / (24 * 60))}d`;
}
