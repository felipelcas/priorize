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
        return await handlePrioritize(request, env);
      }

      if (request.method === "POST" && url.pathname === "/calmai") {
        return await handleCalmai(request, env);
      }

      if (request.method === "POST" && url.pathname === "/briefai") {
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

function mustBeString(name, val, { required = false, min = 0, max = 9999 } = {}) {
  const v = cleanText(val);
  if (required && !v) throw new Error(`Preencha: ${name}.`);
  if (!required && !v) return "";

  if (v.length < min) throw new Error(`${name} muito curto.`);
  if (v.length > max) throw new Error(`${name} passou do limite de caracteres.`);
  if (looksLikeInjection(v)) throw new Error(`${name} parece ter conteúdo perigoso.`);

  return v;
}

function mustBeInt(name, val, { min = 0, max = 999999 } = {}) {
  const n = Number(val);
  if (!Number.isInteger(n)) throw new Error(`${name} inválido.`);
  if (n < min || n > max) throw new Error(`${name} fora do intervalo.`);
  return n;
}

async function readJson(request) {
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

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.error?.message || "Erro na OpenAI.";
    throw new Error(msg);
  }
  return data;
}

function stripQuestionMarksDeep(obj) {
  const clean = (s) => cleanText(String(s || "")).replace(/\?/g, "").replace(/[\s]+$/g, "").trim();

  if (typeof obj === "string") return clean(obj);

  if (Array.isArray(obj)) return obj.map((x) => stripQuestionMarksDeep(x));

  if (obj && typeof obj === "object") {
    const out = {};
    for (const k of Object.keys(obj)) out[k] = stripQuestionMarksDeep(obj[k]);
    return out;
  }

  return obj;
}

async function handlePrioritize(request, env) {
  const body = await readJson(request);

  const name = mustBeString("Seu nome", body.name, { required: true, min: 2, max: 60 });
  const method = mustBeString("Método", body.method, { required: true, min: 3, max: 40 });

  if (method !== "impact_effort") {
    return json({ error: "Por enquanto, só o método Impacto e Esforço está liberado." }, 400);
  }

  if (!Array.isArray(body.tasks)) {
    return json({ error: "tasks deve ser uma lista." }, 400);
  }

  const tasksRaw = body.tasks.slice(0, 10);
  if (tasksRaw.length < 3) {
    return json({ error: "Envie no mínimo 3 tarefas." }, 400);
  }

  const tasks = tasksRaw.map((t, idx) => {
    const title = mustBeString(`Tarefa ${idx + 1} - título`, t.title, { required: true, min: 3, max: 80 });
    const description = mustBeString(`Tarefa ${idx + 1} - descrição`, t.description, { required: true, min: 10, max: 800 });

    const importance = mustBeInt(`Tarefa ${idx + 1} - importância`, t.importance, { min: 1, max: 5 });
    const time_cost = mustBeInt(`Tarefa ${idx + 1} - tempo`, t.time_cost, { min: 1, max: 5 });

    const importance_label = mustBeString(`Tarefa ${idx + 1} - rótulo importância`, t.importance_label, { required: true, min: 2, max: 40 });
    const time_label = mustBeString(`Tarefa ${idx + 1} - rótulo tempo`, t.time_label, { required: true, min: 2, max: 40 });

    return { title, description, importance, time_cost, importance_label, time_label };
  });

  const model = env?.OPENAI_MODEL || "gpt-4o-mini";

  const system = [
    "Você é o PriorizAI.",
    "Fale como um colega de trabalho legal, simples e direto.",
    "O usuário tem 16 anos e pouca instrução.",
    "Use o nome do usuário e cite as tarefas para personalizar.",
    "Muito importante: use também a descrição para estimar tempo e complexidade e importância real.",
    "Se a escolha do usuário estiver incoerente com a descrição, ajuste sua análise sem julgar e explique gentilmente.",
    "Não invente fatos externos. Use só o que foi informado.",
    "Retorne SOMENTE JSON no schema pedido.",
  ].join(" ");

  const rule =
    "Método Impacto e Esforço: faça primeiro o que é MAIS IMPORTANTE e leva MENOS TEMPO. " +
    "Depois o que é muito importante mesmo se levar mais tempo. " +
    "Por último, coisas pouco importantes e demoradas.";

  const schema = {
    name: "PriorizeResult",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["friendly_message", "method_used", "estimated_time_saved_percent", "summary", "ordered_tasks"],
      properties: {
        friendly_message: { type: "string" },
        method_used: { type: "string" },
        estimated_time_saved_percent: { type: "integer", minimum: 0, maximum: 80 },
        summary: { type: "string" },
        ordered_tasks: {
          type: "array",
          minItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["position", "task_title", "explanation", "key_points", "tip"],
            properties: {
              position: { type: "integer", minimum: 1, maximum: 10 },
              task_title: { type: "string" },
              explanation: { type: "string" },
              key_points: { type: "array", minItems: 2, maxItems: 4, items: { type: "string" } },
              tip: { type: "string" },
            },
          },
        },
      },
    },
  };

  const user = {
    name,
    method,
    rule,
    tasks,
    response_rules: [
      "Compare IMPORTÂNCIA e TEMPO escolhidos com a DESCRIÇÃO.",
      "Se a descrição indicar tempo maior ou menor, considere isso.",
      "Se a descrição indicar urgência, considere isso.",
      "Retorne somente o JSON.",
      "friendly_message: curto e personalizado.",
      "summary: 2 a 3 frases.",
      "Para cada tarefa: explanation (2 a 5 frases), key_points (2 a 4 itens), tip (1 frase).",
      "estimated_time_saved_percent: inteiro 0..80, realista.",
    ],
  };

  const payload = {
    model,
    temperature: 0.6,
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(user) },
    ],
    response_format: { type: "json_schema", json_schema: schema },
  };

  const out = await openaiChat(env, payload);
  const content = out?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Resposta vazia da OpenAI.");

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Não consegui ler a resposta da IA em JSON.");
  }

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

  const userText = `Nome: ${name}\nProblema: ${text}`;

  const payload = {
    model,
    temperature: 0.9,
    messages: [
      { role: "system", content: diva },
      { role: "user", content: userText },
    ],
  };

  const out = await openaiChat(env, payload);
  const reply = out?.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error("Resposta vazia da OpenAI.");

  return json({ reply }, 200);
}

async function handleBriefai(request, env) {
  const body = await readJson(request);

  const name = mustBeString("Seu nome", body.name, { required: true, min: 2, max: 60 });
  const text = mustBeString("Seu texto", body.text, { required: true, min: 20, max: 1500 });

  const model = env?.OPENAI_MODEL || "gpt-4o-mini";

  const system = [
    "Você é o BriefAI.",
    "Linguagem simples, direta e objetiva. Sem termos difíceis.",
    "Não faça perguntas ao usuário.",
    "Não use o caractere de interrogação.",
    "Não termine com interrogação.",
    "Não invente fatos externos. Use só o texto fornecido.",
    "Não peça dados sensíveis.",
    "Se o texto parecer ter dados sensíveis, inclua um aviso curto para não colar esse tipo de informação.",
    "Retorne SOMENTE JSON no schema pedido.",
  ].join(" ");

  const schema = {
    name: "BriefAIResponse",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["friendlyMessage", "summary", "brief", "missingInfo", "nextSteps"],
      properties: {
        friendlyMessage: { type: "string" },
        summary: { type: "string" },
        brief: { type: "string" },
        missingInfo: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 10 },
        nextSteps: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 10 },
      },
    },
  };

  const user = {
    name,
    text,
    output_rules: [
      "friendlyMessage: 1 a 2 frases, personalizado com o nome.",
      "summary: 4 a 7 linhas curtas, fáceis de ler.",
      "brief: deve ter blocos fixos com esses títulos: Contexto, Objetivo, O que está acontecendo, Restrições e riscos, Plano de ação curto.",
      "missingInfo: lista de pontos ausentes, sem perguntas.",
      "nextSteps: lista objetiva de próximos passos, sem perguntas.",
      "Não usar interrogação e não escrever frases em formato de pergunta.",
    ],
  };

  const payload = {
    model,
    temperature: 0.5,
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(user) },
    ],
    response_format: { type: "json_schema", json_schema: schema },
  };

  const out = await openaiChat(env, payload);
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
