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

      if (request.method === "POST" && url.pathname === "/prioritize") {
        const limited = await enforceDailyIpLimit(request, env);
        if (limited) return limited;
        return await handlePrioritize(request, env);
      }

      if (request.method === "POST" && url.pathname === "/calmai") {
        const limited = await enforceDailyIpLimit(request, env);
        if (limited) return limited;
        return await handleCalmai(request, env);
      }

      if (request.method === "POST" && url.pathname === "/briefai") {
        const limited = await enforceDailyIpLimit(request, env);
        if (limited) return limited;
        return await handleBriefai(request, env);
      }

      return json({ error: "Rota não encontrada." }, 404);
    } catch (err) {
      return json({ error: err?.message || "Erro inesperado." }, 500);
    }
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

/**
 * Rate limit: 3 usos por dia por IP (sem armazenar IP puro).
 * Requer:
 * - Durable Object binding: RATE_LIMITER
 * - Secret/Var: IP_HASH_SALT (use "wrangler secret put IP_HASH_SALT")
 * - Var opcional: IP_DAILY_LIMIT (default: 3)
 */
function getClientIp(request) {
  // Cloudflare
  const cf = request.headers.get("CF-Connecting-IP");
  if (cf) return cf.trim();

  // Fallback
  const xff = request.headers.get("X-Forwarded-For");
  if (xff) return xff.split(",")[0].trim();

  return "";
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input));
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function enforceDailyIpLimit(request, env) {
  const ip = getClientIp(request);
  if (!ip) {
    return json({ error: "Não consegui identificar o IP da requisição." }, 400);
  }

  if (!env?.RATE_LIMITER) {
    throw new Error("RATE_LIMITER não configurado no wrangler.toml (Durable Object binding).");
  }

  const salt = env?.IP_HASH_SALT;
  if (!salt) {
    throw new Error("IP_HASH_SALT não configurada no Worker (use Secrets/Vars).");
  }

  const limit = mustBeInt("IP_DAILY_LIMIT", env?.IP_DAILY_LIMIT ?? 3, { min: 1, max: 1000 });
  const ipHash = await sha256Hex(`${salt}|${ip}`);
  const shard = ipHash.slice(0, 2) || "00";

  const id = env.RATE_LIMITER.idFromName(shard);
  const stub = env.RATE_LIMITER.get(id);

  const res = await stub.fetch("https://rate/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ipHash, day: todayUtc(), limit }),
  });

  if (res.status === 429) {
    return json(
      {
        error: "Limite diário por IP atingido. Tente novamente amanhã.",
        code: "RATE_LIMITED",
        limit,
      },
      429
    );
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(txt || "Falha ao validar limite por IP.");
  }

  return null;
}

function cleanText(text) {
  return String(text || "").replace(/\u0000/g, "").trim();
}

function looksLikeInjection(text) {
  const t = cleanText(text).toLowerCase();

  // XSS comuns
  const xss = ["<script", "</script", "<iframe", "<object", "<embed", "<svg", "javascript:", "onerror=", "onload="];
  if (xss.some((p) => t.includes(p))) return true;

  // SQLi (heurística)
  const sqli = [
    " union select",
    "drop table",
    "insert into",
    "delete from",
    "update ",
    " or 1=1",
    "' or '1'='1",
    "\" or \"1\"=\"1",
    "--",
    "/*",
    "*/",
  ];
  if (sqli.some((p) => t.includes(p))) return true;

  return false;
}

function mustBeString(name, val, { required = false, min = 0, max = 999999 } = {}) {
  const v = cleanText(val);

  if (required && !v) throw new Error(`Preencha: ${name}.`);
  if (!required && !v) return "";

  if (v.length < min) throw new Error(`${name} está muito curto.`);
  if (v.length > max) throw new Error(`${name} passou do limite de caracteres.`);

  if (looksLikeInjection(v)) {
    throw new Error(`${name} parece ter conteúdo perigoso. Ajuste o texto e tente de novo.`);
  }
  return v;
}

function mustBeInt(name, val, { min = 0, max = 999999 } = {}) {
  const n = Number(val);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`${name} deve ser um inteiro.`);
  if (n < min) throw new Error(`${name} deve ser >= ${min}.`);
  if (n > max) throw new Error(`${name} deve ser <= ${max}.`);
  return n;
}

async function readJson(request) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error("Content-Type deve ser application/json.");
  }
  let body;
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
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
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
    const msg = (data && (data.error?.message || data.message)) || text || "Erro na OpenAI.";
    throw new Error(msg);
  }

  return data || {};
}

function stripQuestionMarksDeep(value) {
  if (typeof value === "string") {
    return value.replaceAll("?", "").replaceAll("¿", "");
  }
  if (Array.isArray(value)) {
    return value.map(stripQuestionMarksDeep);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = stripQuestionMarksDeep(v);
    }
    return out;
  }
  return value;
}

async function handlePrioritize(request, env) {
  const body = await readJson(request);

  const name = mustBeString("Seu nome", body.name, { required: true, min: 2, max: 60 });
  const method = mustBeString("Método", body.method, { required: true, min: 2, max: 40 });

  const tasks = body.tasks;
  if (!Array.isArray(tasks)) throw new Error("tasks deve ser uma lista.");
  if (tasks.length < 3) throw new Error("Preencha no mínimo 3 tarefas completas.");
  if (tasks.length > 10) throw new Error("Máximo de 10 tarefas.");

  const normalizedTasks = tasks.map((t, idx) => {
    const title = mustBeString(`Tarefa ${idx + 1} - título`, t?.title, { required: true, min: 3, max: 80 });
    const description = mustBeString(`Tarefa ${idx + 1} - descrição`, t?.description, { required: true, min: 10, max: 800 });

    const importance = mustBeInt(`Tarefa ${idx + 1} - importância`, t?.importance, { min: 1, max: 5 });
    const time_cost = mustBeInt(`Tarefa ${idx + 1} - tempo`, t?.time_cost, { min: 1, max: 5 });

    const importance_label = mustBeString(`Tarefa ${idx + 1} - importância_label`, t?.importance_label, { required: false, min: 0, max: 50 });
    const time_label = mustBeString(`Tarefa ${idx + 1} - time_label`, t?.time_label, { required: false, min: 0, max: 50 });

    return {
      title,
      description,
      importance,
      time_cost,
      importance_label,
      time_label,
    };
  });

  const model = env?.OPENAI_MODEL || "gpt-4o-mini";

  const sys = [
    "Você é um assistente que prioriza tarefas de forma profissional e objetiva.",
    "Responda SEM interrogação. Não use '?' nem '¿'.",
    "Responda sempre em português do Brasil.",
    "Retorne estritamente um JSON válido no formato abaixo.",
    "Formato esperado:",
    "{",
    '  "friendly_message": "string",',
    '  "summary": "string",',
    '  "estimated_time_saved_percent": number,',
    '  "ordered_tasks": [',
    "    {",
    '      "position": "1",',
    '      "task_title": "string",',
    '      "explanation": "string",',
    '      "key_points": ["string", "string"],',
    '      "tip": "string"',
    "    }",
    "  ]",
    "}",
  ].join("\n");

  const usr = {
    name,
    method,
    tasks: normalizedTasks,
  };

  const out = await openaiChat(env, {
    model,
    temperature: 0.4,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: JSON.stringify(usr) },
    ],
    response_format: { type: "json_object" },
  });

  const content = out?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Resposta vazia da OpenAI.");

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Não consegui ler a resposta da IA em JSON.");
  }

  // Enforce: sem interrogação
  parsed = stripQuestionMarksDeep(parsed);

  return json(parsed, 200);
}

async function handleCalmai(request, env) {
  const body = await readJson(request);

  const name = mustBeString("Seu nome", body.name, { required: true, min: 2, max: 60 });
  const text = mustBeString("Texto", body.text, { required: true, min: 10, max: 500 });

  const model = env?.OPENAI_MODEL || "gpt-4o-mini";

  const diva = [
    "Você é a Diva do Caos, uma conselheira provocadora, amiga debochada e mentora perspicaz.",
    "Fala de forma informal, cheia de gírias, provoca e cutuca os usuários, alternando entre carinho e ironia.",
    "Sempre provoca os usuários.",
    "Seja concisa.",
    "Dê um conselho engraçado, inteligente, provocador e reflexivo.",
    "NÃO invente fatos. Use só o que o usuário contou.",
    "SEMPRE termine com UMA pergunta provocante e direta.",
  ].join(" ");

  const out = await openaiChat(env, {
    model,
    temperature: 0.8,
    messages: [
      { role: "system", content: diva },
      { role: "user", content: `Nome: ${name}\n\nTexto: ${text}` },
    ],
  });

  const content = out?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Resposta vazia da OpenAI.");

  return json({ reply: content }, 200);
}

async function handleBriefai(request, env) {
  const body = await readJson(request);

  const name = mustBeString("Seu nome", body.name, { required: true, min: 2, max: 60 });
  const text = mustBeString("Seu texto", body.text, { required: true, min: 20, max: 1500 });

  const model = env?.OPENAI_MODEL || "gpt-4o-mini";

  const sys = [
    "Você é um analista que transforma texto bagunçado em briefing estruturado e objetivo.",
    "Responda SEM interrogação. Não use '?' nem '¿'.",
    "Responda sempre em português do Brasil.",
    "Retorne estritamente um JSON válido no formato abaixo.",
    "Formato esperado:",
    "{",
    '  "friendlyMessage": "string",',
    '  "summary": "string",',
    '  "brief": "string",',
    '  "missingInfo": ["string"],',
    '  "nextSteps": ["string"]',
    "}",
  ].join("\n");

  const usr = {
    name,
    text,
  };

  const out = await openaiChat(env, {
    model,
    temperature: 0.4,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: JSON.stringify(usr) },
    ],
    response_format: { type: "json_object" },
  });

  const content = out?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Resposta vazia da OpenAI.");

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Não consegui ler a resposta da IA em JSON.");
  }

  // Enforce: sem interrogação
  parsed = stripQuestionMarksDeep(parsed);

  return json(parsed, 200);
}

/**
 * Durable Object: RateLimiter
 * Armazena somente um hash do IP (não armazena IP puro).
 * Estrutura por ipHash: { day: "YYYY-MM-DD", count: number }
 */
export class RateLimiter {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return this.jsonResponse({ error: "JSON inválido." }, 400);
    }

    const ipHash = String(body?.ipHash || "").trim();
    const day = String(body?.day || "").trim();
    const limit = Number(body?.limit);

    if (!ipHash || !day || !Number.isFinite(limit)) {
      return this.jsonResponse({ error: "Body inválido." }, 400);
    }

    const key = ipHash;

    const current = await this.state.storage.get(key);
    let count = 0;

    if (current && current.day === day && Number.isFinite(current.count)) {
      count = current.count;
    }

    if (count >= limit) {
      return this.jsonResponse({ allowed: false, limit, remaining: 0 }, 429);
    }

    count += 1;
    await this.state.storage.put(key, { day, count });

    return this.jsonResponse({ allowed: true, limit, remaining: Math.max(0, limit - count) }, 200);
  }

  jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}
