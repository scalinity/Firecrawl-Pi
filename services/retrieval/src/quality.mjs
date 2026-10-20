// Content adequacy and failure classification (FIRECRAWL_PI_SPEC.md §9.2, §9.4). A page is judged
// by its status, type and structure, never by length alone: a short page with no sign of client
// rendering is adequate, and a page is a JS shell only when it also carries structure that says
// the content is rendered by script (scripts present, an empty application mount point, a
// noscript notice asking for JavaScript, or inline scripts holding several times the text shown).
//   verdicts: adequate | js_shell | challenge | auth_gate | not_found | rate_limited |
//             access_denied | target_error | binary
const TEXT_TYPES = /^(text\/|application\/(xhtml\+xml|xml|json|ld\+json|rss\+xml|atom\+xml|javascript)|[^;]*\+(xml|json)\s*(;|$))/i;
const HTML_TYPES = /^(text\/html|application\/xhtml\+xml)/i;

// Recognised public-content bot interstitials. Each marker is structural (a challenge platform's
// script path, form or element id), not a phrase a normal article could contain.
const CHALLENGE_MARKERS = [
  /\/cdn-cgi\/challenge-platform\//i, /\bcf-chl-(?:widget|opt|bypass)\b/i, /<title>\s*Just a moment\.\.\.\s*<\/title>/i,
  /\bid=["']challenge-(?:form|running|stage)["']/i, /\b_Incapsula_Resource\b/i, /\bgeo\.captcha-delivery\.com\b/i,
  /\bpx-captcha\b/i, /\bddos-guard\b[^<]{0,40}<\/title>/i, /<title>\s*Attention Required! \| Cloudflare\s*<\/title>/i,
  // M6: search engines' own CAPTCHA pages (DuckDuckGo's anomaly check, Google's /sorry/ form) and AWS WAF's challenge.
  /\bid=["']anomaly-modal["']/i, /\/anomaly\.js\b/i, /<form\b[^<>]*\baction=["'][^"']*\/sorry\/index\b/i, /\bid=["']captcha-form["']/i, /\bwindow\.gokuProps\b/,
  // Reddit's human-verification gate, by its whole title (the other sign is redditGate's, on the URL).
  /<title>\s*Reddit - Prove your humanity\s*<\/title>/i,
];
// Reddit's gate returns the browser to the page's own URL with js_challenge and jsc_token added; both together, on
// reddit.com or a subdomain, mark the gate whatever the page then shows.
export const redditGate = (url) => {
  try {
    const u = new URL(url);
    return /(^|\.)reddit\.com$/i.test(u.hostname) && u.searchParams.has("js_challenge") && u.searchParams.has("jsc_token");
  } catch { return false; }
};
// Recognised edge refusals of the connection's address on a public page, read only on a 403: Akamai's "Access
// Denied" page, whose reference points at its error host (entity-encoded as it serves it), and Cloudflare's
// "used Cloudflare to restrict access" page (errors 1006-1008, 1020). Each names the edge network, not the site's
// own authorization, so the home connection being refused is a block the residential route may answer (spec §9.2).
const EDGE_BLOCK_MARKERS = [
  /\berrors(?:\.|&#46;)edgesuite(?:\.|&#46;)net\b/i,
  /<title>\s*Access denied \| [^<]{1,253} used Cloudflare to restrict access\s*<\/title>/i,
];
const LOGIN_PATH = /\/(log-?in|sign-?in|auth|session|account\/log-?in|users\/sign_in|accounts\/login)(\/|\?|$)/i;

export const isTextual = (contentType) => !contentType || TEXT_TYPES.test(contentType);
export const isHtml = (contentType) => !contentType || HTML_TYPES.test(contentType);

// Markup is read in one left-to-right pass: every search starts where the previous one ended, so
// the cost is linear in the document's length whatever the markup. Lazy regexes over unclosed
// markup cost openers × length and let one page stall the service's event loop (CWE-1333).
const HIDDEN = ["script", "style", "noscript", "template", "svg", "head"];
const CLOSER = Object.fromEntries(HIDDEN.map((t) => [t, new RegExp(`</${t}\\s*>`, "gi")]));
const TAG = /^<(\/?)([a-z][a-z0-9-]*)/i;

// Calls onText(start, end) for each run of text outside tags and hidden elements, and
// onHidden(tag, start, end, opener) with each hidden element's content and the offset of its opening tag.
// A hidden element that never closes is read as an ordinary tag, and later openers of that tag are not
// searched again.
function walk(html, onText, onHidden) {
  const unclosed = new Set();
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { onText(i, html.length); return; }
    onText(i, lt);
    if (html.startsWith("<!--", lt)) {
      const e = html.indexOf("-->", lt + 4);
      i = e < 0 ? html.length : e + 3;
      continue;
    }
    const m = TAG.exec(html.slice(lt, lt + 64));
    const markup = m || html[lt + 1] === "!" || html[lt + 1] === "?";
    if (!markup) { onText(lt, lt + 1); i = lt + 1; continue; } // a "<" that starts no tag is text
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0) return; // an unterminated tag runs to the end of the document
    i = gt + 1;
    const name = m && !m[1] ? m[2].toLowerCase() : null;
    if (!name || !(name in CLOSER) || unclosed.has(name) || html[gt - 1] === "/") continue;
    const close = CLOSER[name];
    close.lastIndex = i;
    const found = close.exec(html);
    if (!found) { unclosed.add(name); continue; }
    onHidden?.(name, i, found.index, lt);
    i = close.lastIndex;
  }
}

// The visible text of an HTML document: scripts, styles, templates, SVG, noscript, the head and
// comments removed.
export function visibleText(html) {
  const parts = [];
  walk(html, (a, b) => { if (b > a) parts.push(html.slice(a, b)); }, null);
  return parts.join(" ").replace(/&(nbsp|#160);/gi, " ").replace(/\s+/g, " ").trim();
}

// An application mount point (div or main with one of the usual ids) that is empty, or holds only
// a noscript notice. Each [^<>] stops at the next tag and the notice is read in a bounded window,
// so no candidate scans past its own element.
const MOUNT = /<(div|main)\b[^<>]*\bid=["'](root|app|__next|__nuxt|svelte|content)["'][^<>]*>/gi;
function emptyMountIn(html) {
  MOUNT.lastIndex = 0;
  for (let m; (m = MOUNT.exec(html)); ) {
    const rest = html.slice(MOUNT.lastIndex, MOUNT.lastIndex + 4096);
    const inner = /^\s*(?:<noscript\b[^<>]*>[^<]{0,2000}<\/noscript>\s*)?<\/(div|main)\s*>/i.exec(rest);
    if (inner && inner[1].toLowerCase() === m[1].toLowerCase()) return true;
  }
  return false;
}

// A JSON-LD block is search-engine metadata that static pages carry too; it renders nothing.
const LD_JSON = /\btype\s*=\s*["']?application\/ld\+json/i;
// The inline script text between offsets a and b, JSON-LD left out. walk() reports <head> as one hidden element, so
// the scripts inside it (where a page's data blob often sits) are read here, in one forward pass.
const SCRIPT_OPEN = /<script\b[^<>]*>/gi, SCRIPT_CLOSE = /<\/script\s*>/gi;
function scriptCharsIn(html, a, b) {
  let n = 0;
  SCRIPT_OPEN.lastIndex = a;
  for (let m; (m = SCRIPT_OPEN.exec(html)) && m.index < b; ) {
    const start = SCRIPT_OPEN.lastIndex;
    SCRIPT_CLOSE.lastIndex = start;
    const c = SCRIPT_CLOSE.exec(html);
    const end = c && c.index < b ? c.index : b;
    if (!LD_JSON.test(m[0])) n += end - start;
    SCRIPT_OPEN.lastIndex = c && c.index < b ? SCRIPT_CLOSE.lastIndex : b;
  }
  return n;
}
export function htmlSignals(html) {
  const scripts = (html.match(/<script\b/gi) ?? []).length;
  const notices = [];
  let scriptChars = 0;
  walk(html, () => {}, (tag, a, b, opener) => {
    if (tag === "noscript" && notices.length < 16) notices.push(html.slice(a, Math.min(b, a + 4096)));
    if (tag === "script" && !LD_JSON.test(html.slice(opener, a))) scriptChars += b - a;
    if (tag === "head") scriptChars += scriptCharsIn(html, a, b);
  });
  const noscript = notices.join(" ");
  const loading = /\bclass=["'][^"'<>]*\b(loading|spinner|skeleton)\b/i.test(html);
  return { scripts, scriptChars, noscriptAsksForJs: /(enable|requires?|needs?|turn on)[^<]{0,40}javascript|javascript[^<]{0,40}(required|disabled|enable)/i.test(noscript), emptyMount: emptyMountIn(html), loading };
}

// status: final HTTP status; contentType; body: string for textual types; finalUrl, requestedUrl.
export function classify({ status, contentType, body, finalUrl, requestedUrl, retryAfter = null }) {
  if (status === 429) return { verdict: "rate_limited", failure: { class: "RATE_LIMITED", detail: "the target asked the client to slow down", retryable: true, retryAfter } };
  if (status === 401) return { verdict: "auth_gate", failure: { class: "AUTH_REQUIRED", detail: "the target requires authentication", retryable: false, retryAfter: null } };
  if (status === 404 || status === 410) return { verdict: "not_found", reasons: [`status ${status}`] };
  const text = typeof body === "string" ? body : "";
  const html = isHtml(contentType) && typeof body === "string";
  const challenge = (html && CHALLENGE_MARKERS.some((re) => re.test(text))) || redditGate(finalUrl);
  if (challenge) {
    return { verdict: "challenge", failure: { class: "BLOCKED_PUBLIC_CONTENT", detail: "the target served a bot interstitial", retryable: true, retryAfter: null } };
  }
  if (status === 403 && html && EDGE_BLOCK_MARKERS.some((re) => re.test(text))) {
    return { verdict: "challenge", failure: { class: "BLOCKED_PUBLIC_CONTENT", detail: "the target's edge network refused this connection's address", retryable: true, retryAfter: null } };
  }
  if (status === 403) return { verdict: "access_denied", failure: { class: "ACCESS_DENIED", detail: "the target refused access (403)", retryable: false, retryAfter: null } };
  if (status >= 500) return { verdict: "target_error", reasons: [`status ${status}`] };
  if (!isTextual(contentType)) return { verdict: "binary", reasons: [contentType] };
  if (!html) return { verdict: "adequate", reasons: ["non-HTML text"] };
  // An authentication gate reached by redirect: a different final URL on a login path, carrying a
  // password field. Never retried or escalated (spec §9.2).
  if (finalUrl !== requestedUrl && LOGIN_PATH.test(new URL(finalUrl).pathname) && /<input\b[^<>]*type=["']?password/i.test(text)) {
    return { verdict: "auth_gate", failure: { class: "AUTH_REQUIRED", detail: "the target redirected to a sign-in page", retryable: false, retryAfter: null } };
  }
  const visible = visibleText(text);
  const s = htmlSignals(text);
  const reasons = [`visible_chars=${visible.length}`, `scripts=${s.scripts}`];
  // structural: the page itself says its content is rendered by script. Length alone (a short
  // page that carries a script) may earn the one browser attempt, but never fails a rendered page
  // (spec §9.2, §9.4).
  if (s.noscriptAsksForJs && visible.length < 500) return { verdict: "js_shell", visibleChars: visible.length, structural: true, reasons: [...reasons, "noscript asks for JavaScript"] };
  if (s.emptyMount && s.scripts > 0 && visible.length < 500) return { verdict: "js_shell", visibleChars: visible.length, structural: true, reasons: [...reasons, "empty application mount point"] };
  if (s.scripts > 0 && visible.length < 200 && (s.loading || visible.length < 40)) return { verdict: "js_shell", visibleChars: visible.length, structural: s.loading, reasons: [...reasons, s.loading ? "scripted page showing a loading placeholder" : "scripted page with almost no text"] };
  // A short page whose inline scripts hold several times the text it shows: the content is in the script, waiting
  // to be rendered (a data array a script writes into the page). Length-based, so it earns the one browser
  // attempt and never fails a rendered page.
  if (visible.length < 500 && s.scriptChars >= 1000 && s.scriptChars >= 4 * visible.length) {
    return { verdict: "js_shell", visibleChars: visible.length, structural: false, reasons: [...reasons, `script_chars=${s.scriptChars}`, "inline scripts hold several times the text the page shows"] };
  }
  return { verdict: "adequate", visibleChars: visible.length, reasons };
}
