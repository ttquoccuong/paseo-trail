/**
 * The host of a link the daemon sent, or "" when it does not parse. The daemon only sends URLs it
 * could parse, but a client must never let one odd link stop the whole bar from drawing.
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/**
 * `url` when it is safe to open for a link on `forgeUrl`'s forge: https anywhere, or http on the
 * forge's own host (a self-hosted GitLab without TLS). Null for any other scheme, such as a
 * `javascript:` or `file:` URL a forge answer might carry.
 */
export function openableUrl(url: string, forgeUrl: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return url;
    return parsed.protocol === "http:" && parsed.host === hostOf(forgeUrl) ? url : null;
  } catch {
    return null;
  }
}
