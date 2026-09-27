import crypto from "node:crypto";
import cors from "cors";
import express from "express";
import { SlotConfig, auditHtml, analyzeCss, callSlot, countDomNodes } from "./cascade.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = Number(process.env.PORT ?? 3001);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

/** Proxy {base_url}/models so local providers work without CORS config. Never gates a run. */
app.get("/api/models", async (req, res) => {
  const baseUrl = String(req.query.base_url ?? "").replace(/\/$/, "");
  const apiKey = String(req.query.api_key ?? "");
  if (!baseUrl) return res.status(400).json({ error: "base_url required" });
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const r = await fetch(`${baseUrl}/models`, { headers });
    const text = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: text.slice(0, 500) });
    try {
      const j = JSON.parse(text);
      const models = (j?.data ?? []).map((m: any) => m.id ?? m.name).filter(Boolean);
      res.json({ models });
    } catch {
      res.json({ models: [] });
    }
  } catch (e: any) {
    const host = baseUrl.replace(/\/v1\/?$/, "");
    res.status(502).json({ error: `Cannot reach ${host} — is the server running? (${e?.message ?? e})` });
  }
});

/** Server-side audit of arbitrary HTML (used by the "verify constraint" check). */
app.post("/api/audit", (req, res) => {
  const html = String(req.body?.html ?? "");
  const { violations, disqualified } = auditHtml(html);
  const css = analyzeCss(html);
  res.json({
    violations,
    disqualified,
    badge: disqualified ? "DISQUALIFIED" : violations.length ? "VIOLATION" : "CLEAN",
    ...css,
    domNodeCount: countDomNodes(html),
    bytes: Buffer.byteLength(html, "utf8"),
    sha256: crypto.createHash("sha256").update(html).digest("hex").slice(0, 16),
  });
});

app.post("/api/cascade", async (req, res) => {
  const { prompt, slotA, slotB, slots } = req.body ?? {};
  const a: SlotConfig | undefined = slotA ?? slots?.A;
  const b: SlotConfig | undefined = slotB ?? slots?.B;
  if (typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "prompt (string) required" });
  }
  if (!a || !b) return res.status(400).json({ error: "slotA and slotB configs required" });
  for (const [name, s] of [["slotA", a], ["slotB", b]] as const) {
    if (!s.baseUrl || !s.model) {
      return res.status(400).json({ error: `${name}.baseUrl and ${name}.model required` });
    }
  }

  // Fresh random nonce per run, IDENTICAL for both slots: proves zero prompt reuse
  // while keeping the prompt identical across models.
  const nonce = crypto.randomBytes(8).toString("hex");
  const promptWithNonce = `${prompt.trim()}\n\n<!-- cascade-run:${nonce} -->`;

  const [ra, rb] = await Promise.all([callSlot(a, promptWithNonce, nonce), callSlot(b, promptWithNonce, nonce)]);
  res.json({ nonce, slotA: ra, slotB: rb });
});

app.listen(PORT, () => console.log(`cascade server on :${PORT}`));
