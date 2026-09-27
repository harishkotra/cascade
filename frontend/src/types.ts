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

export type Stage = "idle" | "composing" | "auditing" | "rendering" | "finished" | "error";

export const PROVIDERS: Record<string, { baseUrl: string; needsKey: boolean; staticModels: string[] }> = {
  "Particle.ai": {
    baseUrl: "https://api.particle.ai/v1",
    needsKey: true,
    staticModels: ["deepseek-v4.1-flash", "deepseek-v4-flash-0731", "glm5.3flash"],
  },
  Ollama: { baseUrl: "http://127.0.0.1:11434/v1", needsKey: false, staticModels: [] },
  "LM Studio": { baseUrl: "http://127.0.0.1:1234/v1", needsKey: false, staticModels: [] },
  OpenRouter: { baseUrl: "https://openrouter.ai/api/v1", needsKey: true, staticModels: [] },
  Custom: { baseUrl: "", needsKey: false, staticModels: [] },
};

export const DEFAULT_A: SlotConfig = {
  provider: "Particle.ai",
  baseUrl: "https://api.particle.ai/v1",
  apiKey: "",
  model: "deepseek-v4-flash-0731",
  temperature: 0,
  maxTokens: 1600,
  disableReasoning: true,
};

export const DEFAULT_B: SlotConfig = {
  provider: "Particle.ai",
  baseUrl: "https://api.particle.ai/v1",
  apiKey: "",
  model: "deepseek-v4.1-flash",
  temperature: 0,
  maxTokens: 1600,
  disableReasoning: true,
};

const CONSTRAINT =
  "using ONLY HTML and CSS. No JavaScript, no SVG, no images, no external assets, no libraries. Output only one Original complete HTML file.";

export const PRESETS: { label: string; subject: string }[] = [
  { label: "a loading spinner", subject: "a loading spinner" },
  { label: "a beating heart", subject: "a beating heart" },
  { label: "a bouncing ball with squash and stretch", subject: "a bouncing ball with squash and stretch" },
  { label: "a page transition wipe", subject: "a page transition wipe" },
];

export function buildPrompt(subject: string): string {
  return `Build an animated ${subject} ${CONSTRAINT}`;
}

/** Deliberately JS-based animation: must render FROZEN under sandbox="" and audit DISQUALIFIED. */
export const JS_POISON = `<!DOCTYPE html><html><head><style>
#ball{width:60px;height:60px;border-radius:50%;background:red;position:absolute;left:0;top:40px}
</style></head><body>
<div id="ball"></div>
<script>setInterval(()=>{const b=document.getElementById('ball');b.style.left=(parseInt(b.style.left||'0')+5)%300+'px'},50);</script>
</body></html>`;
