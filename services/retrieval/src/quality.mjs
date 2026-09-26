// Content adequacy and failure classification (FIRECRAWL_PI_SPEC.md §9.2, §9.4). A page is judged
// by its status, type and structure, never by length alone: a short page with no sign of client
// rendering is adequate, and a page is a JS shell only when it also carries structure that says
// the content is rendered by script (scripts present, an empty application mount point, or a
// noscript notice asking for JavaScript).
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
];
const LOGIN_PATH = /\/(log-?in|sign-?in|auth|session|account\/log-?in|users\/sign_in|accounts\/login)(\/|\?|$)/i;

export const isTextual = (contentType) => !contentType || TEXT_TYPES.test(contentType);
export const isHtml = (contentType) => !contentType || HTML_TYPES.test(contentType);

// The visible text of an HTML document: scripts, styles, templates, SVG and noscript removed.
export function visibleText(html) {
  return html
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(nbsp|#160);/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function htmlSignals(html) {
  const scripts = (html.match(/<script\b/gi) ?? []).length;
  const noscript = [...html.matchAll(/<noscript\b[^>]*>([\s\S]*?)<\/noscript>/gi)].map((m) => m[1]).join(" ");
  const emptyMount = /<(div|main)\b[^>]*\bid=["'](root|app|__next|__nuxt|svelte|content)["'][^>]*>\s*(<noscript\b[\s\S]*?<\/noscript>\s*)?<\/\1>/i.test(html);
  const loading = /\bclass=["'][^"']*\b(loading|spinner|skeleton)\b/i.test(html);
  return { scripts, noscriptAsksForJs: /(enable|requires?|needs?|turn on)[^<]{0,40}javascript|javascript[^<]{0,40}(required|disabled|enable)/i.test(noscript), emptyMount, loading };
}

// status: final HTTP status; contentType; body: string for textual types; finalUrl, requestedUrl.
export function classify({ status, contentType, body, finalUrl, requestedUrl, retryAfter = null }) {
  if (status === 429) return { verdict: "rate_limited", failure: { class: "RATE_LIMITED", detail: "the target asked the client to slow down", retryable: true, retryAfter } };
  if (status === 401) return { verdict: "auth_gate", failure: { class: "AUTH_REQUIRED", detail: "the target requires authentication", retryable: false, retryAfter: null } };
  if (status === 404 || status === 410) return { verdict: "not_found", reasons: [`status ${status}`] };
  const text = typeof body === "string" ? body : "";
  const html = isHtml(contentType) && typeof body === "string";
  const challenge = html && CHALLENGE_MARKERS.some((re) => re.test(text));
  if (challenge) {
    return { verdict: "challenge", failure: { class: "BLOCKED_PUBLIC_CONTENT", detail: "the target served a bot interstitial; escalation needs the residential proxy path (M6)", retryable: true, retryAfter: null } };
  }
  if (status === 403) return { verdict: "access_denied", failure: { class: "ACCESS_DENIED", detail: "the target refused access (403)", retryable: false, retryAfter: null } };
  if (status >= 500) return { verdict: "target_error", reasons: [`status ${status}`] };
  if (!isTextual(contentType)) return { verdict: "binary", reasons: [contentType] };
  if (!html) return { verdict: "adequate", reasons: ["non-HTML text"] };
  // An authentication gate reached by redirect: a different final URL on a login path, carrying a
  // password field. Never retried or escalated (spec §9.2).
  if (finalUrl !== requestedUrl && LOGIN_PATH.test(new URL(finalUrl).pathname) && /<input\b[^>]*type=["']?password/i.test(text)) {
    return { verdict: "auth_gate", failure: { class: "AUTH_REQUIRED", detail: "the target redirected to a sign-in page", retryable: false, retryAfter: null } };
  }
  const visible = visibleText(text);
  const s = htmlSignals(text);
  const reasons = [`visible_chars=${visible.length}`, `scripts=${s.scripts}`];
  if (s.noscriptAsksForJs && visible.length < 500) return { verdict: "js_shell", reasons: [...reasons, "noscript asks for JavaScript"] };
  if (s.emptyMount && s.scripts > 0 && visible.length < 500) return { verdict: "js_shell", reasons: [...reasons, "empty application mount point"] };
  if (s.scripts > 0 && visible.length < 200 && (s.loading || visible.length < 40)) return { verdict: "js_shell", reasons: [...reasons, "scripted page with almost no text"] };
  return { verdict: "adequate", reasons };
}
