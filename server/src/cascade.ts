import crypto from "node:crypto";
import postcss from "postcss";

export interface SlotConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  disableReasoning: boolean;
}

export interface SlotResult {
  html: string;
  rawReply: string;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  sha256: string;
  violations: string[];
  disqualified: boolean;
  extractionPath: string;
  cssRuleCount: number;
  domNodeCount: number;
  animationCount: number;
  chips: string[];
  error?: string;
  nonce: string;
}

const SYSTEM_PROMPT = "You are a precise assistant. Answer the user's request directly.";

/** Static compliance audit, computed server-side on the real HTML bytes. */
export function auditHtml(html: string): { violations: string[]; disqualified: boolean } {
  const violations: string[] = [];
  const lower = html.toLowerCase();

  if (/<script[\s>]/i.test(html)) violations.push("script tag (<script>)");
  if (/\son\w+\s*=/i.test(html.replace(/<\s*style[\s\S]*?<\/\s*style\s*>/gi, ""))) {
    violations.push("on* event handler attribute");
  }
  if (/javascript\s*:/i.test(html)) violations.push("javascript: URL");
  for (const tag of ["img", "svg", "canvas", "video", "audio", "iframe", "object", "embed"]) {
    if (new RegExp(`<${tag}[\\s>/]`, "i").test(html)) violations.push(`<${tag}> tag`);
  }
  if (/@import/i.test(html)) violations.push("@import rule");
  const linkRemote = /<link[^>]+href\s*=\s*["']https?:\/\//i.test(html);
  if (linkRemote) violations.push("<link> to remote URL");
  // url() pointing off-site: http(s), protocol-relative, or data:
  const urlMatches = html.match(/url\(\s*["']?([^)"']+)["']?\s*\)/gi) ?? [];
  for (const m of urlMatches) {
    const inner = m.replace(/^url\(\s*["']?/i, "").replace(/["']?\s*\)$/i, "").trim().toLowerCase();
    if (
      inner.startsWith("http://") ||
      inner.startsWith("https://") ||
      inner.startsWith("//") ||
      inner.startsWith("data:")
    ) {
      violations.push(`off-site url(): ${inner.slice(0, 80)}`);
      break;
    }
  }
  void lower;

  const disqualified =
    /<script[\s>]/i.test(html) ||
    /\son\w+\s*=/i.test(html.replace(/<\s*style[\s\S]*?<\/\s*style\s*>/gi, ""));
  return { violations, disqualified };
}

/** Extract the HTML: prefer a ```html fence, fall back to a doc containing <html or <style. */
export function extractHtml(reply: string): { html: string; path: string } {
  const fence = reply.match(/```html\s*([\s\S]*?)```/i);
  if (fence) return { html: fence[1].trim(), path: "fence:```html" };
  const anyFence = reply.match(/```\s*([\s\S]*?)```/);
  if (anyFence && /<html|<style/i.test(anyFence[1])) {
    return { html: anyFence[1].trim(), path: "fence:generic" };
  }
  const idx = reply.search(/<html|<!doctype/i);
  if (idx >= 0) return { html: reply.slice(idx).trim(), path: "doctype/<html" };
  const styleIdx = reply.search(/<style/i);
  if (styleIdx >= 0) {
    return {
      html: `<!DOCTYPE html><html><head></head><body>${reply.slice(styleIdx).trim()}</body></html>`,
      path: "style-fallback",
    };
  }
  return { html: reply.trim(), path: "raw" };
}

const CHIP_PROPS = [
  "animation",
  "animation-name",
  "animation-duration",
  "animation-timing-function",
  "animation-delay",
  "animation-iteration-count",
  "animation-direction",
  "transition",
  "transform",
  "filter",
  "clip-path",
  "opacity",
  "background",
  "conic-gradient",
  "linear-gradient",
  "radial-gradient",
  "keyframes",
  "box-shadow",
  "border-radius",
  "@keyframes",
  "@media",
  "perspective",
  "backdrop-filter",
  "mix-blend-mode",
  "mask",
];

export function analyzeCss(html: string): {
  cssRuleCount: number;
  animationCount: number;
  chips: string[];
} {
  const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style\s*>/gi)].map((m) => m[1]);
  const inlineStyles = [...html.matchAll(/style\s*=\s*["']([^"']*)["']/gi)].map((m) => m[1]);
  const css = styleBlocks.join("\n");
  let cssRuleCount = 0;
  let animationCount = 0;
  const found = new Set<string>();
  try {
    const root = postcss.parse(css);
    root.walk((node: any) => {
      if (node.type === "rule" || node.type === "atrule") cssRuleCount++;
      if (node.type === "atrule" && node.name === "keyframes") {
        animationCount++;
        found.add("@keyframes " + (node.params || ""));
      }
      if (node.type === "decl") {
        const prop = node.prop.toLowerCase();
        const val = String(node.value).toLowerCase();
        if (prop.startsWith("animation") || prop === "transition") animationCount++;
        for (const c of CHIP_PROPS) {
          if (prop.includes(c.replace("@", ""))) found.add(prop);
        }
        for (const g of ["conic-gradient", "linear-gradient", "radial-gradient"]) {
          if (val.includes(g)) found.add(g);
        }
        for (const p of ["transform", "filter", "clip-path", "opacity", "box-shadow", "mask", "perspective", "backdrop-filter", "mix-blend-mode"]) {
          if (prop === p) found.add(p);
        }
      }
    });
  } catch {
    cssRuleCount = (css.match(/[{}]/g) ?? []).length / 2 || 0;
    cssRuleCount = Math.floor(cssRuleCount);
  }
  for (const s of inlineStyles) {
    const low = s.toLowerCase();
    for (const p of ["transform", "filter", "clip-path", "opacity", "transition", "animation"]) {
      if (low.includes(p)) found.add(`${p} (inline)`);
    }
  }
  if (inlineStyles.length > 0) cssRuleCount += inlineStyles.length;
  return { cssRuleCount, animationCount, chips: [...found].sort().slice(0, 40) };
}

export function countDomNodes(html: string): number {
  const matches = html.match(/<[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>/g) ?? [];
  return matches.filter((t) => !t.startsWith("</")).length;
}

function errorHint(baseUrl: string, errText: string): string {
  const host = baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
  if (/fetch failed|econnrefused|enotfound|econnreset|socket|network/i.test(errText)) {
    const provider = host.includes("11434")
      ? "Ollama"
      : host.includes("1234")
        ? "LM Studio"
        : null;
    return `Cannot reach ${host}${provider ? ` — is ${provider} running?` : ""} (${errText})`;
  }
  return errText;
}

export async function callSlot(
  slot: SlotConfig,
  promptWithNonce: string,
  nonce: string
): Promise<SlotResult> {
  const baseUrl = slot.baseUrl.replace(/\/$/, "");
  const url = `${baseUrl}/chat/completions`;
  const empty: SlotResult = {
    html: "",
    rawReply: "",
    latencyMs: 0,
    promptTokens: null,
    completionTokens: null,
    reasoningTokens: null,
    sha256: "",
    violations: [],
    disqualified: false,
    extractionPath: "none",
    cssRuleCount: 0,
    domNodeCount: 0,
    animationCount: 0,
    chips: [],
    nonce,
  };

  let maxTokens = Math.round(slot.maxTokens || 1600);
  const isParticle = slot.provider === "Particle.ai";
  const isDeepseek = slot.model.startsWith("deepseek-");

  for (let attempt = 0; attempt < 2; attempt++) {
    const body: Record<string, unknown> = {
      model: slot.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: promptWithNonce },
      ],
      temperature: slot.temperature ?? 0,
      max_tokens: maxTokens,
    };
    // Only Particle.ai + deepseek-* understands this field; others ignore/reject it.
    if (slot.disableReasoning && isParticle && isDeepseek) {
      body.chat_template_kwargs = { enable_thinking: false };
    }
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (slot.apiKey) headers.Authorization = `Bearer ${slot.apiKey}`;

    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (e: any) {
      return { ...empty, error: errorHint(baseUrl, e?.message ?? String(e)) };
    }
    const latencyMs = Date.now() - t0;
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 500);
      try {
        const j = JSON.parse(text);
        detail = j?.error?.message ?? j?.message ?? detail;
      } catch { /* keep raw */ }
      return { ...empty, latencyMs, error: `${res.status} from ${baseUrl}: ${detail}` };
    }
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      return { ...empty, latencyMs, error: `Non-JSON response from ${baseUrl}` };
    }
    const msg = data?.choices?.[0]?.message ?? {};
    // STRIP reasoning_content: never log, display, or persist it.
    const content: string = typeof msg.content === "string" ? msg.content : "";
    const usage = data?.usage ?? {};
    const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null;
    const completionTokens =
      typeof usage.completion_tokens === "number" ? usage.completion_tokens : null;
    const rt = usage?.completion_tokens_details?.reasoning_tokens;
    const reasoningTokens = typeof rt === "number" ? rt : null;

    if (!content.trim()) {
      // HTTP 200 with empty content: hidden CoT may have eaten the budget — retry once doubled, cap 4000.
      if (attempt === 0) {
        maxTokens = Math.min(maxTokens * 2, 4000);
        continue;
      }
      return { ...empty, latencyMs, promptTokens, completionTokens, reasoningTokens, error: "Empty content after retry (budget may have been consumed by hidden reasoning)." };
    }

    const { html, path } = extractHtml(content);
    const { violations, disqualified } = auditHtml(html);
    const css = analyzeCss(html);
    return {
      html,
      rawReply: content,
      latencyMs,
      promptTokens,
      completionTokens,
      reasoningTokens,
      sha256: crypto.createHash("sha256").update(html).digest("hex").slice(0, 16),
      violations,
      disqualified,
      extractionPath: path,
      cssRuleCount: css.cssRuleCount,
      domNodeCount: countDomNodes(html),
      animationCount: css.animationCount,
      chips: css.chips,
      nonce,
    };
  }
  return { ...empty, error: "Unexpected failure" };
}
