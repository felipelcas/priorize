export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (url.pathname !== "/prioritize") return new Response("Not Found", { status: 404, headers: cors });

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

    const clamp = (v, min, max, fallback) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return fallback;
      const i = Math.round(n);
      return Math.max(min, Math.min(max, i));
    };

    const userName = String(body.userName || "").trim();
    const tasks = Array.isArray(body.tasks) ? body.tasks : [];

    const filled = tasks
      .map((t) => {
        const title = String(t.title || "").trim();
        const description = String(t.description || "").trim();
        const importance = clamp(t.importance, 1, 5, 3);
        const time = clamp(t.time ?? t.effort, 1, 5, 3);
        return { title, description, importance, time };
      })
      .filter((t) => t.title && t.description);

    if (!userName) {
      return new Response(JSON.stringify({ error: "Informe seu nome." }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    if (filled.length < 3) {
      return new Response(JSON.stringify({ error: "Preencha no mínimo 3 tarefas completas." }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    if (!env.OPENAI_API_KEY) {
      return new Response(JSON.stringify({ error: "OPENAI_API_KEY não configurada no Worker." }), {
        status: 500,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const model = env.OPENAI_MODEL || "gpt-4o-mini";

    const system = `
Você é o PriorizAI.
Fale simples, direto e amigável.
Use também a descrição para ajustar tempo e importância, se o usuário marcou errado.
Não invente fatos externos.
Retorne JSON.
`.trim();

    const user = `
Nome: ${userName}
Método: IMPACT_EFFORT

Regras:
- Faça primeiro o que ajuda mais e leva menos tempo.
- Se tiver prazo/urgência na descrição, considere isso.
- Dê dicas práticas.

Tarefas (JSON):
${JSON.stringify(filled)}
`.trim();

    const schema = {
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
                keyPoints: { type: "array", minItems: 2, maxItems: 4, items: { type: "string" } },
                tip: { type: "string" },
              },
            },
          },
        },
      },
    };

    async function callOpenAI(response_format) {
      return fetch("https://api.openai.com/v1/chat/completions", {
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
          response_format,
        }),
      });
    }

    // 1) Tenta json_schema (Structured Outputs)
    let resp = await callOpenAI({ type: "json_schema", json_schema: schema });
    let data = await resp.json().catch(() => ({}));

    // 2) Se falhar por compatibilidade do response_format, faz fallback para json_object
    if (!resp.ok) {
      const msg = data?.error?.message || "";
      const looksLikeSchemaUnsupported =
        msg.toLowerCase().includes("response_format") || msg.toLowerCase().includes("json_schema");

      if (looksLikeSchemaUnsupported) {
        resp = await callOpenAI({ type: "json_object" });
        data = await resp.json().catch(() => ({}));
      }
    }

    if (!resp.ok) {
      console.error("OpenAI error:", data);
      return new Response(
        JSON.stringify({
          error: "Erro na IA",
          message: data?.error?.message || "Falha ao chamar a OpenAI.",
        }),
        { status: 502, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const content = data?.choices?.[0]?.message?.content || "";
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      console.error("Invalid JSON from model:", content);
      return new Response(JSON.stringify({ error: "Erro na IA", message: "A resposta não veio em JSON válido." }), {
        status: 502,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify(parsed), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  },
};
