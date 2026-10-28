export interface SanitizeResult {
  text: string;
  changes: string[];
}

export function isAllowedUrl(raw: string, allowedHosts: string[]): boolean {
  let allowed = false;
  try {
    const url = new URL(raw);
    allowed = (url.protocol === "https:" || url.protocol === "http:")
      && allowedHosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    allowed = false;
  }
  return allowed;
}

// Markdown images and links are the classic channel for exfiltrating data through a renderer.
export function sanitizeAnswer(input: string, allowedHosts: string[]): SanitizeResult {
  const changes: string[] = [];
  let images = 0;
  let html = 0;
  let links = 0;
  let schemes = 0;
  let text = input.replace(/!\[[^\]]*\]\([^)]*\)/g, () => { images++; return ""; });
  text = text.replace(/<\/?[a-z][^>]*>/gi, () => { html++; return ""; });
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_match, label: string, url: string) => {
    if (isAllowedUrl(url, allowedHosts)) {
      return `${label} (${url})`;
    }
    links++;
    return label;
  });
  text = text.replace(/\b(?:https?|ftp):\/\/[^\s<>"')\]]+/gi, url => {
    if (isAllowedUrl(url, allowedHosts)) {
      return url;
    }
    links++;
    return "[link removed]";
  });
  text = text.replace(/\b(?:javascript|data|vbscript):\S*/gi, () => { schemes++; return "[link removed]"; });
  if (images) {
    changes.push(`removed ${images} image(s)`);
  }
  if (html) {
    changes.push(`removed ${html} HTML tag(s)`);
  }
  if (links) {
    changes.push(`removed ${links} non-allowlisted link(s)`);
  }
  if (schemes) {
    changes.push(`removed ${schemes} script or data URL(s)`);
  }
  return { text: text.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim(), changes };
}
