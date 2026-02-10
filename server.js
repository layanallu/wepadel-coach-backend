import express from "express";

const app = express();

// Render / proxies friendly
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// CORS (safe default for MVP; tighten later)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).send("");
  next();
});

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "wepadel-coach-backend",
    endpoints: ["POST /coach/chat", "GET /health"],
    tip: "Use POST /coach/chat?debug=1 to return full Gemini response for troubleshooting."
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

function buildSystemBlock(contextPack) {
  const coachPersona = contextPack?.coachPersona ?? "";
  const playerProfile = contextPack?.playerProfile ?? "";
  const recentMatchesSummary = contextPack?.recentMatchesSummary ?? "";
  const constraints = contextPack?.constraints ?? "";

  return `
${coachPersona}

${playerProfile}

Recent matches:
${recentMatchesSummary}

Constraints:
${constraints}
`.trim();
}

function normalizeThread(thread) {
  const turns = (thread?.turns ?? [])
    .slice(-10)
    .map((t) => ({
      role: t?.role === "user" ? "user" : "model",
      parts: [{ text: String(t?.text ?? "") }]
    }));

  return turns;
}

function extractReply(json) {
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p?.text ?? "").join("");

  // extra safety trim
  return (text && text.trim().length > 0)
    ? text.trim()
    : "I’m here. Tell me what you want to improve today.";
}

app.post("/coach/chat", async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Missing GEMINI_API_KEY" });
    }

    const { userMessage, contextPack, thread } = req.body ?? {};

    if (!userMessage || typeof userMessage !== "string") {
      return res.status(400).json({ error: "Missing or invalid userMessage" });
    }

    if (!contextPack || typeof contextPack !== "object") {
      return res.status(400).json({ error: "Missing or invalid contextPack" });
    }

    const systemBlock = buildSystemBlock(contextPack);
    const turns = normalizeThread(thread);

    const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    // ✅ Increase token budget + force plain text
    const body = {
      systemInstruction: { parts: [{ text: systemBlock }] },
      contents: [
        ...turns,
        { role: "user", parts: [{ text: userMessage }] }
      ],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1200,
        responseMimeType: "text/plain"
      }
    };

    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });

    const rawText = await r.text();

    if (!r.ok) {
      return res.status(502).json({
        error: "Gemini call failed",
        status: r.status,
        detail: rawText
      });
    }

    const json = JSON.parse(rawText);

    const reply = extractReply(json);

    // ✅ Debug mode: returns finishReason + token info + full JSON
    const debug = String(req.query.debug ?? "") === "1";
    if (debug) {
      const finishReason = json?.candidates?.[0]?.finishReason ?? null;
      const usage = json?.usageMetadata ?? null;

      return res.json({
        reply,
        meta: { model, finishReason, usage },
        raw: json
      });
    }

    return res.json({ reply });
  } catch (e) {
    return res.status(500).json({ error: "Unexpected error" });
  }
});

// Render exposes PORT
const port = Number(process.env.PORT ?? 10000);
app.listen(port, () => {
  console.log(`WePadel Coach Backend running on port ${port}`);
});

