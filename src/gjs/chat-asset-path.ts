export function chatAssetPath(value: unknown): string | undefined {
  if (typeof value !== "string" || /[\\\s\x00-\x1f\x7f#]/u.test(value)) return undefined;
  if (!/^\/api\/(?:tasks\/[^/?]+\/artifacts\/[^?]+(?:\?[^#]*)?|files\/download\?(?:upload|path)=[^&]+)$/u.test(value)) return undefined;
  try {
    const path = decodeURIComponent(value.split("?", 1)[0]);
    if (!/[\\\x00-\x1f\x7f]/u.test(path) && !path.split("/").some((part) => part === "." || part === "..")) return value;
  } catch { /* An invalid escape cannot identify a file. */ }
  return undefined;
}

