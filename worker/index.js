/* worker/src/index.js - Cloudflare Worker (API PriorizAI + CalmAI + BriefAI) */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS básico
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      if (request.method === "GET" && url.pathname === "/") {
        return json({ ok: true, service: "priorizai-worker" }, 200);
      }

      // Rate limit por IP: IP_DAILY_LIMIT usos por dia (America/Sao_Paulo)
      if (request.method === "POST" && isLimitedPath(url.pathname)) {
        const limit = getDailyLimit(env);
        const blocked = await enforceDailyRateLimit(request, env, limit);
        if (blocked) return blocked;
      }

      if (request.method === "POST" && url.pathname === "/prioritize") {
        const body = await readJson(request);

        // validação mínima
        const tasks = Array.isArray(body.tasks) ? body.tasks : [];
        if (!tasks.length) throw new Error("Informe ao menos 1 tarefa.");

        // input sanitization simples
        const hasBad = tasks.some(
          (t) =>
            looksLikeInjection(t?.title) ||
            looksLikeInjection(t?.context) ||
            looksLikeInjection(t?.impact) ||
            looksLikeInjection(t?.effort)
        );
        if (hasBad) throw new Error("Conteúdo inválido detectado.");

        const result = await handlePrioritize(env, body);
        return json({ ok: true, data: result }, 200);
      }

      if (request.method === "POST" && url.pathname === "/calmai") {
        const body = await readJson(request);

        const text = cleanText(body?.text);
        if (!text) throw new Error("Informe o texto.");
        if (looksLikeInjection(text)) throw new Error("Conteúdo inválido detectado.");

        const result = await handleCalmAI(env, body);
        return json({ ok: true, data: result }, 200);
      }

      if (request.method === "POST" && url.pathname === "/briefai") {
        const body = await readJson(request);

        const text = cleanText(body?.text);
        if (!text) throw new Error("Informe o texto.");
        if (looksLikeInjection(text)) throw new Error("Conteúdo inválido detectado.");

        const result = await handleBriefAI(env, body);
        return json({ ok: true, data: result }, 200);
      }

      return json({ ok: false, error: "Not Found" }, 404);
    } catch (err) {
      const msg = err?.message || "Erro interno";
      return json({ ok: false, error: msg }, 500);
    }
  },
};

function isLimitedPath(pathname) {
  return pathname === "/prioritize" || pathname === "/calmai" || pathname === "/briefai";
}

function getDailyLimit(env) {
  // Lê do painel: Variables (não secret)
  // Aceita string ou número. Fallback: 3.
  const raw = env?.IP_DAILY_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return 3;
  return n;
}

function getClientIp(request) {
  const h = request.headers;
  const cfIp = h.get("CF-Connecting-IP");
  if (cfIp) return cfIp.trim();

  const xff = h.get("X-Forwarded-For");
  if (xff) return xff.split(",")[0].trim();

  return "";
}

function saoPauloDateKey() {
  // Formato YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function nextDayKey(dateKey) {
  // dateKey: YYYY-MM-DD
  const [y, m, d] = String(dateKey).split("-").map((n) => parseInt(n, 10));
  const next = new Date(Date.UTC(y, (m || 1) - 1, d || 1) + 86400000);
  return next.toISOString().slice(0, 10);
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input));
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function enforceDailyRateLimit(request, env, limit) {
  const kv = env?.RATE_LIMIT_KV;
  if (!kv) {
    return json(
      { ok: false, code: "CONFIG_ERROR", message: "RATE_LIMIT_KV não configurado no Worker." },
      500
    );
  }

  const salt = env?.HASH_SALT;
  if (!salt) {
    return json(
      { ok: false, code: "CONFIG_ERROR", message: "HASH_SALT não configurado no Worker." },
      500
    );
  }

  const ip = getClientIp(request) || "0.0.0.0";
  const day = saoPauloDateKey();
  const hash = await sha256Hex(`${salt}:${ip}`);
  const key = `rl:${day}:${hash}`;

  const currentRaw = await kv.get(key);
  const current = parseInt(currentRaw || "0", 10) || 0;

  if (current >= limit) {
    const resetDay = nextDayKey(day);
    const resetAt = `${resetDay}T00:00:00-03:00`;
    return json(
      {
        ok: false,
        code: "RATE_LIMITED",
        message: "Limite diário atingido.",
        limit,
        remaining: 0,
        resetAt,
      },
      429
    );
  }

  const nextCount = current + 1;
  // TTL de 48h para limpar o dia anterior automaticamente.
  await kv.put(key, String(nextCount), { expirationTtl: 172800 });

  return null;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

async function readJson(request) {
  let body = null;
  try {
    body = await request.json();
  } catch {
    throw new Error("JSON inválido.");
  }
  if (!body || typeof body !== "object") throw new Error("Body inválido.");
  return body;
}

function requireOpenAIKey(env) {
  const key = env?.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY não configurada no Worker (Secrets/Vars).");
  return key;
}

async function openaiChat(env, payload) {
  const key = requireOpenAIKey(env);
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }

  if (!res.ok) {
    const msg = data?.error?.message || data?.message || text || "Falha no OpenAI.";
    throw new Error(msg);
  }
  return data;
}

function cleanText(text) {
  return String(text || "").replace(/\u0000/g, "").trim();
}

function looksLikeInjection(text) {
  const t = cleanText(text).toLowerCase();

  // XSS comuns
  if (t.includes("<script") || t.includes("javascript:") || t.includes("onerror=")) return true;

  // Tentativas de prompt injection muito genéricas
  if (t.includes("ignore previous") || t.includes("system prompt") || t.includes("developer message"))
    return true;

  // URLs suspeitas longas
  if (t.includes("http://") || t.includes("https://")) {
    if (t.length > 2000) return true;
  }

  return false;
}

// ========= Handlers =========

async function handlePrioritize(env, body) {
  const tasks = Array.isArray(body.tasks) ? body.tasks : [];
  const method = cleanText(body?.method) || "impact_effort";

  const model = env?.OPENAI_MODEL || "gpt-4o-mini";

  const system = `
Você é um assistente de priorização. Retorne JSON estrito, sem markdown.
Objetivo: ordenar tarefas por prioridade.
Método: ${method}.
Formato de saída:
{
  "ordered_tasks": [
    {"position": 1, "task_title": "..." }
  ]
}
`;

  const user = {
    method,
    tasks: tasks.map((t) => ({
      title: cleanText(t?.title),
      context: cleanText(t?.context),
      impact: cleanText(t?.impact),
      effort: cleanText(t?.effort),
    })),
  };

  const payload = {
    model,
    temperature: 0.2,
    messages: [
      { role: "system", content: system.trim() },
      { role: "user", content: JSON.stringify(user) },
    ],
    response_format: { type: "json_object" },
  };

  const out = await openaiChat(env, payload);
  const content = out?.choices?.[0]?.message?.content || "{}";
  return safeParseJson(content, { ordered_tasks: [] });
}

async function handleCalmAI(env, body) {
  const text = cleanText(body?.text);
  const tone = cleanText(body?.tone) || "neutro";
  const model = env?.OPENAI_MODEL || "gpt-4o-mini";

  const system = `
Você reescreve mensagens para reduzir conflito. Retorne JSON estrito, sem markdown.
Formato:
{"rewritten_text":"..."}
`;

  const user = { tone, text };

  const payload = {
    model,
    temperature: 0.4,
    messages: [
      { role: "system", content: system.trim() },
      { role: "user", content: JSON.stringify(user) },
    ],
    response_format: { type: "json_object" },
  };

  const out = await openaiChat(env, payload);
  const content = out?.choices?.[0]?.message?.content || "{}";
  return safeParseJson(content, { rewritten_text: "" });
}

async function handleBriefAI(env, body) {
  const text = cleanText(body?.text);
  const style = cleanText(body?.style) || "executivo";
  const model = env?.OPENAI_MODEL || "gpt-4o-mini";

  const system = `
Você resume textos de forma objetiva. Retorne JSON estrito, sem markdown.
Formato:
{"summary":"...","bullets":["...","..."]}
`;

  const user = { style, text };

  const payload = {
    model,
    temperature: 0.3,
    messages: [
      { role: "system", content: system.trim() },
      { role: "user", content: JSON.stringify(user) },
    ],
    response_format: { type: "json_object" },
  };

  const out = await openaiChat(env, payload);
  const content = out?.choices?.[0]?.message?.content || "{}";
  return safeParseJson(content, { summary: "", bullets: [] });
}

function safeParseJson(text, fallback) {
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === "object" ? obj : fallback;
  } catch {
    return fallback;
  }
}
