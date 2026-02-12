export default {
  async fetch(request, env) {
    // CORS simples (você pode restringir depois)
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    if (url.pathname !== "/prioritize") {
      return new Response("Not Found", { status: 404, headers: cors });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Use POST" }), {
        status: 405,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "JSON inválido" }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const userName = String(body.userName || "").trim();
    const method = String(body.method || "IMPACT_EFFORT").trim();
    const tasks = Array.isArray(body.tasks) ? body.tasks : [];

    const filled = tasks
      .map((t) => ({
        title: String(t.title || "").trim(),
        description: String(t.description || "").trim(),
        importance: Number(t.importance),
        effort: Number(t.effort),
      }))
      .filter((t) => t.title && t.description);

    if (!userName) {
      return new Response(JSON.stringify({ error: "Informe seu nome." }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    if (filled.length < 3) {
      return new Response(
        JSON.stringify({ error: "Preencha no mínimo 3 tarefas completas." }),
        {
          status: 400,
          headers: { ...cors, "Content-Type": "application/json" },
        }
      );
    }

    if (!env.OPENAI_API_KEY) {
      return new Response(
        JSON.stringify({ error: "OPENAI_API_KEY não configurada no Worker." }),
        {
          status: 500,
          headers: { ...cors, "Content-Type": "application/json" },
        }
      );
    }

    const model = env.OPENAI_MODEL || "gpt-4o-mini";

    // Instruções. Linguagem simples, estilo “colega de trabalho”.
    const system = `
Você é o PriorizAI.
Fale simples, direto e amigável.
Considere que o usuário pode errar a escolha de importância e esforço, então use também a descrição para ajustar a análise.
Não invente fatos externos. Use só o que foi informado.
Retorne APENAS JSON, seguindo o schema.
`;

    const rule = `
Método Impacto e Esforço:
- Faça primeiro o que ajuda mais e leva menos tempo.
- Se algo é muito importante (prazo, gente depende, problema grande), pode subir mesmo sendo demorado.
- Coisas pouco importantes e demoradas ficam por último.
`;

    const user = `
Nome: ${userName}
Método: ${method}

Como aplicar:
${rule}

Tarefas (JSON):
${JSON.stringify(filled)}

Regras da resposta:
- Entregue uma ordem final.
- Explique de forma curta e útil.
- Dê dicas práticas.
- estimatedTimeSaved: inteiro de 0 a 80, realista.
`;

    // Schema para o modelo responder em JSON
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

    // Chamada OpenAI (Chat Completions + response_format json_schema)
    // Referência: API de chat completions + response_format. 
    // Retorna JSON “travado” no schema. :contentReference[oaicite:8]{index=8}
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
          { role: "system", content: system.trim() },
          { role: "user", content: user.trim() },
        ],
        response_format: { type: "json_schema", json_schema: jsonSchema },
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      return new Response(
        JSON.stringify({ error: "Erro na IA", details: data }),
        { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const content = data?.choices?.[0]?.message?.content;
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return new Response(
        JSON.stringify({ error: "A IA não retornou JSON válido.", raw: content }),
        { status: 500, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify(parsed), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  },
};
