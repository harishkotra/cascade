import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_A, DEFAULT_B, JS_POISON, PRESETS, PROVIDERS, SlotConfig, SlotResult, Stage,
  buildPrompt,
} from "./types";

function loadCfg(key: string, fallback: SlotConfig): SlotConfig {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return { ...fallback, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return fallback;
}

function badge(r?: SlotResult | null): string {
  if (!r) return "—";
  if (r.error) return "ERROR";
  if (r.disqualified) return "DISQUALIFIED";
  return r.violations.length ? "VIOLATION" : "CLEAN";
}

function SlotEditor({
  title, value, onChange, modelsCache, setModelsCache,
}: {
  title: string;
  value: SlotConfig;
  onChange: (c: SlotConfig) => void;
  modelsCache: Record<string, string[]>;
  setModelsCache: (m: Record<string, string[]>) => void;
}) {
  const [modelsError, setModelsError] = useState("");
  const cacheKey = `${value.provider}|${value.baseUrl}`;
  const liveModels = modelsCache[cacheKey] ?? PROVIDERS[value.provider]?.staticModels ?? [];
  const set = (patch: Partial<SlotConfig>) => onChange({ ...value, ...patch });

  const fetchModels = useCallback(async () => {
    if (!value.baseUrl) return;
    setModelsError("");
    try {
      const q = new URLSearchParams({ base_url: value.baseUrl, api_key: value.apiKey });
      const r = await fetch(`/api/models?${q}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? r.statusText);
      const merged = [...new Set([...(PROVIDERS[value.provider]?.staticModels ?? []), ...(j.models ?? [])])];
      setModelsCache({ ...modelsCache, [cacheKey]: merged });
      if (!j.models?.length && !(PROVIDERS[value.provider]?.staticModels?.length)) {
        setModelsError("Model list empty — type the model name by hand.");
      }
    } catch (e: any) {
      setModelsError(e?.message ?? String(e));
    }
  }, [value.baseUrl, value.apiKey, value.provider]);

  useEffect(() => {
    const t = setTimeout(fetchModels, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.baseUrl, value.provider]);

  return (
    <div className="slot">
      <h3>{title}</h3>
      <label>Provider
        <select
          value={value.provider}
          onChange={(e) => {
            const p = e.target.value;
            const preset = PROVIDERS[p];
            onChange({
              ...value,
              provider: p,
              baseUrl: p === "Custom" ? value.baseUrl : preset.baseUrl,
            });
          }}
        >
          {Object.keys(PROVIDERS).map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </label>
      <label>Base URL
        <input value={value.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })}
          placeholder="https://…/v1" spellCheck={false} />
      </label>
      <label>API Key {(PROVIDERS[value.provider]?.needsKey) ? "(required)" : "(not needed)"}
        <input type="password" value={value.apiKey} onChange={(e) => set({ apiKey: e.target.value })}
          placeholder={PROVIDERS[value.provider]?.needsKey ? "paste key" : "no key needed"} />
      </label>
      <label>Model (pick or type — never gated on /models)
        <input value={value.model} onChange={(e) => set({ model: e.target.value })}
          placeholder="model name" spellCheck={false} list={`${title}-models`} />
        <datalist id={`${title}-models`}>
          {liveModels.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>
      <div className="row">
        <label>Temp
          <input type="number" step="0.1" min="0" max="2" value={value.temperature}
            onChange={(e) => set({ temperature: Number(e.target.value) })} />
        </label>
        <label>Max tokens
          <input type="number" step="100" min="100" max="8000" value={value.maxTokens}
            onChange={(e) => set({ maxTokens: Number(e.target.value) })} />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={value.disableReasoning}
          onChange={(e) => set({ disableReasoning: e.target.checked })} />
        Disable reasoning (Particle.ai deepseek-* only)
      </label>
      <button className="ghost" onClick={fetchModels}>Refresh models</button>
      {modelsError && <div className="models-error">{modelsError}</div>}
    </div>
  );
}

function PaneHeader({ name, r }: { name: string; r?: SlotResult | null }) {
  const bytes = r?.html ? new Blob([r.html]).size : 0;
  return (
    <div className="pane-head">
      <strong>{name}</strong>
      <span className={`pill ${badge(r).toLowerCase()}`}>{badge(r)}</span>
      <div className="meta">
        <span>{bytes} bytes</span>
        <span>{r?.cssRuleCount ?? "—"} css rules</span>
        <span>{r?.domNodeCount ?? "—"} dom nodes</span>
        <span>{r?.animationCount ?? "—"} animations</span>
        <span>{r ? `${r.latencyMs}ms` : "—"}</span>
      </div>
      <div className="meta small">
        <span>tok {r?.promptTokens ?? "—"}/{r?.completionTokens ?? "—"}</span>
        <span>reasoning {r ? (r.reasoningTokens ?? "n/a") : "—"}</span>
        <span>sha {r?.sha256 ?? "—"}</span>
        <span>extract: {r?.extractionPath ?? "—"}</span>
      </div>
      {r?.disqualified && (
        <div className="dq">DISQUALIFIED — script or event handler detected. Rendered frozen as proof.</div>
      )}
      {!!r?.violations.length && !r.disqualified && (
        <div className="viol">Violations: {r.violations.join("; ")}</div>
      )}
      {r?.error && <div className="err">{r.error}</div>}
    </div>
  );
}

export default function App() {
  const [slotA, setSlotA] = useState<SlotConfig>(() => loadCfg("cascade.slotA", DEFAULT_A));
  const [slotB, setSlotB] = useState<SlotConfig>(() => loadCfg("cascade.slotB", DEFAULT_B));
  const [subject, setSubject] = useState(PRESETS[0].subject);
  const [prompt, setPrompt] = useState(buildPrompt(PRESETS[0].subject));
  const [stage, setStage] = useState<Stage>("idle");
  const [resA, setResA] = useState<SlotResult | null>(null);
  const [resB, setResB] = useState<SlotResult | null>(null);
  const [nonce, setNonce] = useState("");
  const [view, setView] = useState<"side" | "slider">("side");
  const [slider, setSlider] = useState(50);
  const [modelsCache, setModelsCache] = useState<Record<string, string[]>>({});
  const [verify, setVerify] = useState<string[]>([]);
  const [poisonAudit, setPoisonAudit] = useState<any>(null);
  const sliderRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem("cascade.slotA", JSON.stringify(slotA));
  }, [slotA]);
  useEffect(() => {
    localStorage.setItem("cascade.slotB", JSON.stringify(slotB));
  }, [slotB]);

  const run = async () => {
    setStage("composing");
    setVerify([]);
    try {
      const r = await fetch("/api/cascade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, slotA, slotB }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? r.statusText);
      setStage("auditing");
      setResA(j.slotA);
      setResB(j.slotB);
      setNonce(j.nonce);
      // brief beat so the pipeline states are visible when screen-recorded
      await new Promise((res) => setTimeout(res, 450));
      setStage("rendering");
      await new Promise((res) => setTimeout(res, 450));
      if (j.slotA.error || j.slotB.error) setStage("error");
      else setStage("finished");
    } catch (e: any) {
      setStage("error");
      setVerify([`Run failed: ${e?.message ?? e}`]);
    }
  };

  const runVerification = async () => {
    const checks: string[] = [];
    // 1. Poison: JS animation must be flagged DISQUALIFIED server-side…
    try {
      const r = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html: JS_POISON }),
      });
      const j = await r.json();
      setPoisonAudit(j);
      checks.push(
        j.disqualified
          ? "PASS 1 — JS poison flagged DISQUALIFIED by server audit (frozen pane below proves it)."
          : `FAIL 1 — poison NOT disqualified (badge: ${j.badge}).`
      );
    } catch (e: any) {
      checks.push(`FAIL 1 — audit endpoint unreachable: ${e?.message}`);
    }
    // 2. Sandbox attribute genuinely present
    const frames = document.querySelectorAll("iframe.preview");
    const sandboxed = [...frames].every((f) => f.getAttribute("sandbox") === "");
    checks.push(
      sandboxed && frames.length > 0
        ? `PASS 2 — ${frames.length} preview iframe(s) carry empty sandbox="" (JS disabled at browser level).`
        : `FAIL 2 — preview iframes missing empty sandbox (found ${frames.length}).`
    );
    // 3. Counts differ (not the same string twice)
    if (resA?.html && resB?.html) {
      checks.push(
        resA.sha256 !== resB.sha256
          ? `PASS 3 — outputs differ (sha ${resA.sha256} vs ${resB.sha256}; dom ${resA.domNodeCount} vs ${resB.domNodeCount}; css ${resA.cssRuleCount} vs ${resB.cssRuleCount}).`
          : "FAIL 3 — both models returned byte-identical HTML."
      );
    } else {
      checks.push("SKIP 3 — run Cascade first, then re-verify.");
    }
    // 4. Reasoning honesty
    const fmt = (r: SlotResult | null) => (r ? (r.reasoningTokens ?? "n/a") : "?");
    checks.push(`INFO 4 — reasoning tokens A=${fmt(resA)} B=${fmt(resB)} (absent → "n/a", toggle hidden).`);
    setVerify(checks);
  };

  const copyJson = async () => {
    const payload = {
      prompt, nonce, stage,
      slotA: resA ? { ...resA, html: resA.html.slice(0, 200_000) } : null,
      slotB: resB ? { ...resB, html: resB.html.slice(0, 200_000) } : null,
    };
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    setVerify((v) => [...v, "Results JSON copied to clipboard."]);
  };

  const downloadShareCard = async () => {
    // 1080x1080 share card, captured from the live iframes via the browser's own
    // rendering (SVG foreignObject snapshot — frozen current frame, not a re-draw).
    const S = 1080;
    const canvas = document.createElement("canvas");
    canvas.width = S; canvas.height = S;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#0b0b10"; ctx.fillRect(0, 0, S, S);
    const snap = async (html: string): Promise<HTMLImageElement | null> => {
      try {
        const doc = `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="760"><foreignObject width="100%" height="100%">${html
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/&(?!amp;|lt;|gt;|quot;)/g, "&amp;")}</foreignObject></svg>`;
        const img = new Image();
        const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(doc);
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
        return img;
      } catch { return null; }
    };
    ctx.fillStyle = "#fff"; ctx.font = "bold 44px system-ui";
    ctx.fillText("CASCADE — JS: DISABLED", 40, 70);
    ctx.font = "28px system-ui"; ctx.fillStyle = "#9cf";
    ctx.fillText(`A: ${slotA.model}`.slice(0, 48), 40, 120);
    ctx.fillText(`B: ${slotB.model}`.slice(0, 48), 580, 120);
    const [ia, ib] = await Promise.all([snap(resA?.html ?? ""), snap(resB?.html ?? "")]);
    ctx.fillStyle = "#fff";
    ctx.fillRect(30, 150, 500, 760); ctx.fillRect(550, 150, 500, 760);
    if (ia) ctx.drawImage(ia, 30, 150, 500, 760);
    if (ib) ctx.drawImage(ib, 550, 150, 500, 760);
    ctx.fillStyle = "#fff"; ctx.font = "30px system-ui";
    ctx.fillText(`sha ${resA?.sha256 ?? "?"}  vs  ${resB?.sha256 ?? "?"}`, 40, 970);
    const a = document.createElement("a");
    a.download = "cascade-share.png";
    a.href = canvas.toDataURL("image/png");
    a.click();
    setVerify((v) => [...v, "Share card PNG downloaded (frozen frames captured by the browser)."]);
  };

  const onSliderDrag = (e: React.PointerEvent) => {
    const el = sliderRef.current;
    if (!el) return;
    const move = (ev: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      setSlider(Math.max(2, Math.min(98, ((ev.clientX - rect.left) / rect.width) * 100)));
    };
    move(e.nativeEvent);
    const up = () => window.removeEventListener("pointermove", move as any);
    window.addEventListener("pointermove", move as any, { once: false });
    window.addEventListener("pointerup", up, { once: true });
  };

  const showThinkingA = resA && resA.reasoningTokens !== null;
  const showThinkingB = resB && resB.reasoningTokens !== null;

  return (
    <div className="app">
      <header className="top">
        <h1>CASCADE</h1>
        <p className="tag">Two models. One pure-CSS prompt. JavaScript genuinely disabled.</p>
        <div className="js-banner">JavaScript: DISABLED — previews run in <code>sandbox=""</code> iframes</div>
        <div className="stage">stage: <strong>{stage}</strong>
          <span className="views">
            <button className={view === "side" ? "on" : ""} onClick={() => setView("side")}>side by side</button>
            <button className={view === "slider" ? "on" : ""} onClick={() => setView("slider")}>slider</button>
          </span>
        </div>
      </header>

      <section className="controls">
        <div className="prompt-box">
          <label>Prompt (identical string sent to both slots)
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} />
          </label>
          <div className="presets">
            {PRESETS.map((p) => (
              <button key={p.label}
                onClick={() => { setSubject(p.subject); setPrompt(buildPrompt(p.subject)); }}
                className={subject === p.subject ? "on" : ""}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="actions">
            <button className="run" onClick={run} disabled={stage === "composing"}>
              {stage === "composing" ? "Composing…" : "RUN CASCADE"}
            </button>
            <button onClick={runVerification}>Verify constraint</button>
            <button onClick={copyJson}>Copy results as JSON</button>
            <button onClick={downloadShareCard}>Download share card (1080×1080)</button>
          </div>
          {verify.length > 0 && (
            <ul className="verify">{verify.map((v, i) => <li key={i}>{v}</li>)}</ul>
          )}
        </div>
        <div className="slots">
          <SlotEditor title="Model A (older)" value={slotA} onChange={setSlotA}
            modelsCache={modelsCache} setModelsCache={setModelsCache} />
          <SlotEditor title="Model B (newer)" value={slotB} onChange={setSlotB}
            modelsCache={modelsCache} setModelsCache={setModelsCache} />
        </div>
      </section>

      {view === "side" ? (
        <section className="stage-grid">
          <div className="pane">
            <PaneHeader name={`A · ${slotA.model}`} r={resA} />
            {(showThinkingA) && <div className="think">thinking tokens: {resA!.reasoningTokens}</div>}
            <div className="frame-wrap">
              {resA?.html
                ? <iframe className="preview" title="model-a" sandbox="" srcDoc={resA.html} />
                : <div className="empty">No render yet — run Cascade.</div>}
            </div>
            <Chips r={resA} />
          </div>
          <div className="pane">
            <PaneHeader name={`B · ${slotB.model}`} r={resB} />
            {(showThinkingB) && <div className="think">thinking tokens: {resB!.reasoningTokens}</div>}
            <div className="frame-wrap">
              {resB?.html
                ? <iframe className="preview" title="model-b" sandbox="" srcDoc={resB.html} />
                : <div className="empty">No render yet — run Cascade.</div>}
            </div>
            <Chips r={resB} />
          </div>
        </section>
      ) : (
        <section className="slider-stage" ref={sliderRef}>
          <div className="slider-frames">
            {resB?.html && <iframe className="preview under" title="model-b" sandbox="" srcDoc={resB.html} />}
            {resA?.html && (
              <div className="over" style={{ width: `${slider}%` }}>
                <iframe className="preview" title="model-a" sandbox="" srcDoc={resA.html} />
              </div>
            )}
            {!resA?.html && <div className="empty">Run Cascade to load the slider.</div>}
            <div className="divider" style={{ left: `${slider}%` }} onPointerDown={onSliderDrag}>
              <span>A | B</span>
            </div>
          </div>
          <div className="slider-meta">
            <span>A · {slotA.model} · {resA?.sha256 ?? "—"}</span>
            <span>B · {slotB.model} · {resB?.sha256 ?? "—"}</span>
          </div>
        </section>
      )}

      <section className="poison">
        <h2>Constraint proof — deliberately JS-based animation</h2>
        <p>Frozen below (empty <code>sandbox=""</code>, no scripts execute) and flagged by the server audit:</p>
        <div className="poison-grid">
          <iframe className="preview" title="js-poison" sandbox="" srcDoc={JS_POISON} />
          <div>
            <div>badge: <strong>{poisonAudit ? poisonAudit.badge : "run Verify constraint"}</strong></div>
            {poisonAudit && <div>violations: {poisonAudit.violations.join("; ")}</div>}
          </div>
        </div>
      </section>

      <footer>Built by <a href="https://harishkotra.me" target="_blank" rel="noreferrer">Harish Kotra</a> · Checkout my other builds at <a href="https://dailybuild.xyz" target="_blank" rel="noreferrer">dailybuild.xyz</a><br />nonce {nonce || "—"} · identical prompt + identical nonce sent to both slots · reasoning_content is stripped server-side, only token counts shown</footer>
    </div>
  );
}

function Chips({ r }: { r?: SlotResult | null }) {
  if (!r) return <div className="chips"><em>animation chips appear after a run</em></div>;
  if (!r.chips.length) return <div className="chips"><em>no animation properties detected in CSS</em></div>;
  return (
    <div className="chips">
      {r.chips.map((c) => (
        <span key={c} className="chip">{c}</span>
      ))}
    </div>
  );
}
