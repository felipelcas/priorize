export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };

    // Preflight CORS
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Health
    if (request.method === "GET" && (path === "/" || path === "/health")) {
      return json({ ok: true, service: "priorizai-worker" }, 200, cors);
    }

    // Só POST nos endpoints
    if (request.method !== "POST") {
      return json({ error: "Use POST." }, 405, cors);
    }

    // Precisa de chave
    if (!env.OPENAI_API_KEY) {
      return json({ error: "OPENAI_API_KEY não configurada no Worker." }, 500, cors);
    }

    // Body JSON
    const body = await safeJson(request);
    if (!body) {
      return json({ error: "JSON inválido." }, 400, cors);
    }

    // Rotas
    if (path === "/prioritize") {
      return handlePrioritize(body, env, cors);
    }

    if (path === "/calmai") {
      return handleCalmAI(body, env, cors);
    }

    return new Response("Not Found", { status: 404, headers: cors });
  },
};

/* -------------------------
   Helpers
------------------------- */

function json(payload, status, cors) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
  });
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function cleanText(input, maxLen) {
  const s = String(input ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ") // remove controles
    .replace(/\s+/g, " ")
    .trim();

  if (!s) return "";

  if (s.length > maxLen) return s.slice(0, maxLen);

  return s;
}

function looksLikeInjection(s) {
  const t = String(s || "").toLowerCase();

  // Comentários SQL típicos
  if (t.includes("--") || t.includes("/*") || t.includes("*/")) return true;

  // Padrões clássicos
  if (/\bunion\s+select\b/i.test(t)) return true;
  if (/\b(or|and)\s+1\s*=\s*1\b/i.test(t)) return true;

  // Script tags (não é SQL, mas é entrada maliciosa comum)
  if (/<\s*script\b/i.test(t)) return true;

  return false;
}

function mustBeBetween(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  if (x < min || x > max) return null;
  return x;
}

/* -------------------------
   /prioritize
------------------------- */

async function handlePrioritize(body, env, cors) {
  const userName = cleanText(body.userName, 60);
  const method = cleanText(body.method || "IMPACT_EFFORT", 30) || "IMPACT_EFFORT";
  const tasksRaw = Array.isArray(body.tasks) ? body.tasks : [];

  if (!userName) return json({ error: "Informe seu nome." }, 400, cors);
  if (looksLikeInjection(userName)) return json({ error: "Nome com conteúdo inválido." }, 400, cors);

  // Aceita campos antigos e novos (compatibilidade)
  const filled = tasksRaw
    .map((t) => {
      const title = cleanText(t?.title, 120);
      const description = cleanText(t?.description, 700);

      // front pode mandar "time", "time_cost" ou "effort". Vamos aceitar qualquer um.
      const importance = mustBeBetween(t?.importance ?? t?.user_chosen_importance, 1, 5);
      const time = mustBeBetween(
        t?.time ?? t?.time_cost ?? t?.effort ?? t?.user_chosen_time_cost,
        1,
        5
      );

      const importanceLabel = cleanText(t?.importanceLabel ?? t?.importance_label, 60);
      const timeLabel = cleanText(t?.timeLabel ?? t?.time_label, 60);

      return { title, description, importance, time, importanceLabel, timeLabel };
    })
    .filter((t) => t.title && t.description);

  if (filled.length < 3) {
    return json({ error: "Preencha no mínimo 3 tarefas completas." }, 400, cors);
  }
  if (filled.length > 10) {
    return json({ error: "No máximo 10 tarefas." }, 400, cors);
  }

  // Bloqueio básico de conteúdo malicioso
  for (const t of filled) {
    if (looksLikeInjection(t.title) || looksLikeInjection(t.description)) {
      return json({ error: "Texto da tarefa com conteúdo inválido." }, 400, cors);
    }
    if (t.importance === null || t.time === null) {
      return json({ error: "Escolha opções válidas para importância e tempo." }, 400, cors);
    }
  }

  const model = env.OPENAI_MODEL || "gpt-4o-mini";

  const system = `
Você é o PriorizAI.
Fale simples, direto e amigável.
Considere que o usuário pode errar a escolha de importância e tempo, então use também a descrição para ajustar a análise.
Não invente fatos externos. Use só o que foi informado.
Retorne APENAS JSON, seguindo o schema.
`.trim();

  const rule = `
Método Impacto e Esforço:
- Faça primeiro o que é mais importante e leva menos tempo.
- Se algo é muito importante (prazo, gente depende, problema grande), pode subir mesmo sendo demorado.
- Coisas pouco importantes e demoradas ficam por último.
`.trim();

  const user = `
Nome: ${userName}
Método: ${method}

Como aplicar:
${rule}

Tarefas (JSON):
${JSON.stringify(filled)}

Regras da resposta:
- Faça um check: compare IMPORTÂNCIA e TEMPO escolhidos com a DESCRIÇÃO.
- Se a descrição indicar urgência, considere isso.
- Retorne uma tabela simples de ordem (position e title) e depois explique.
- friendlyMessage: curto e personalizado.
- summary: 2 a 3 frases.
- Para cada tarefa: explanation (2 a 5 frases), keyPoints (2 a 4 itens), tip (1 frase).
- estimatedTimeSaved: inteiro 0..80, realista.
`.trim();

  const jsonSchema = {
    name: "priorizai_result",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["friendlyMessage", "summary", "estimatedTimeSaved", "rankedTasks"],
      properties: {
        friendlyMessage: { type: "string" },
        summary: { type: "string" },
        estimatedTimeSaved: { type: "integer", minimum: 0, maximum: 80 },
        rankedTasks: {
          type: "array",
          minItems: 3,
          maxItems: 10,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["position", "title", "explanation", "keyPoints", "tip"],
            properties: {
              position: { type: "integer", minimum: 1, maximum: 10 },
              title: { type: "string" },
              explanation: { type: "string" },
              keyPoints: {
                type: "array",
                minItems: 2,
                maxItems: 4,
                items: { type: "string" },
              },
              tip: { type: "string" },
            },
          },
        },
      },
    },
  };

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_schema", json_schema: jsonSchema },
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      return json({ error: "Erro na IA. Verifique o OPENAI_API_KEY e o modelo." }, 500, cors);
    }

    const content = data?.choices?.[0]?.message?.content || "";
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return json({ error: "A IA não retornou JSON válido." }, 500, cors);
    }

    return json(parsed, 200, cors);
  } catch {
    return json({ error: "Falha ao chamar a IA." }, 500, cors);
  }
}

/* -------------------------
   /calmai
------------------------- */

async function handleCalmAI(body, env, cors) {
  // Nome pode ser usado para personalizar, mas aqui não precisa ser obrigatório
  const userName = cleanText(body.userName, 60);
  const text = cleanText(body.text, 500);

  if (!text) return json({ error: "Escreva seu texto." }, 400, cors);
  if (looksLikeInjection(text) || looksLikeInjection(userName)) {
    return json({ error: "Texto com conteúdo inválido." }, 400, cors);
  }

  const model = env.OPENAI_MODEL || "gpt-4o-mini";

  const system = `
Você é a Diva do Caos, uma conselheira provocadora, amiga debochada e mentora perspicaz.
Fala de forma informal, com gírias, alternando entre carinho e ironia.
Seja concisa.
Dê um conselho engraçado, inteligente, provocador e reflexivo.
Sempre termine com UMA pergunta provocante e direta.
Não invente fatos externos. Use só o que o usuário contou.
Responda em português do Brasil.
`.trim();

  const user = `
${userName ? `Nome: ${userName}\n` : ""}Problema do usuário (até 500 caracteres):
${text}
`.trim();

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.8,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      return json({ error: "Erro na IA. Verifique o OPENAI_API_KEY e o modelo." }, 500, cors);
    }

    const reply = (data?.choices?.[0]?.message?.content || "").trim();
    if (!reply) return json({ error: "Resposta vazia da IA." }, 500, cors);

    return json({ reply }, 200, cors);
  } catch {
    return json({ error: "Falha ao chamar a IA." }, 500, cors);
  }
}
