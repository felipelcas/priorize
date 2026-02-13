// =========================
// Config
// =========================
const WORKER_BASE_URL = "https://priorizai.felipelcas.workers.dev";

const MODULE_ENDPOINTS = {
  priorizai: "/prioritize",
  calmai: "/calmai",
  briefai: "/briefai",
};

const MODULE_DESCRIPTIONS = {
  priorizai: "Liste suas tarefas. Eu retorno uma ordem de prioridade clara.",
  calmai:
    "A diva CalmAI reescreve sua mensagem com elegância, calma e objetividade. Você reduz atrito e ganha clareza para conversar com qualquer pessoa.",
  briefai: "Cole um texto longo. Eu retorno um resumo executivo e bullets objetivos.",
};

const PROCESS_BUTTON_LABELS = {
  priorizai: "Gerar priorização",
  calmai: "Gerar mensagem calma",
  briefai: "Gerar briefing",
};

function updateProcessButtonLabel() {
  const btn = document.getElementById("processBtn");
  if (!btn) return;
  btn.textContent = PROCESS_BUTTON_LABELS[currentModule] || "Gerar";
}

// =========================
// State
// =========================
let currentModule = "priorizai";
let isBusy = false;

// =========================
// Helpers
// =========================
function $(id) {
  return document.getElementById(id);
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function setBusy(busy) {
  isBusy = busy;
  const btn = $("processBtn");
  if (btn) {
    btn.disabled = busy;
    btn.title = busy ? "Processando..." : (PROCESS_BUTTON_LABELS[currentModule] || "Gerar");
  }
}

function formatDateTimeBR(iso) {
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      dateStyle: "short",
      timeStyle: "short",
    }).format(d);
  } catch {
    return "";
  }
}

async function callAPI(endpoint, payload) {
  const resp = await fetch(`${WORKER_BASE_URL}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });

  const json = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    const code = json?.code || "";
    if (resp.status === 429 || code === "RATE_LIMITED") {
      const limit = Number(json?.limit ?? 10);
      throw new Error(
        `Desculpa, mas seu limite diário foi atingido. Você pode usar até ${limit} vezes por dia por IP. Tente novamente amanhã.`
      );
    }
    throw new Error(json?.error || json?.message || "Erro ao processar.");
  }

  return json?.data ?? json;
}

// =========================
// Module switching
// =========================
function switchModule(module) {
  currentModule = module;

  // Tabs
  document.querySelectorAll(".module-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.module === module);
  });

  // Contents
  document.querySelectorAll(".module-content").forEach((el) => {
    el.classList.toggle("active", el.dataset.module === module);
  });

  // Description
  const desc = $("moduleDescription");
  if (desc) desc.textContent = MODULE_DESCRIPTIONS[module] || "";
  updateProcessButtonLabel();

  // Reset results placeholder (opcional)
  const results = $("resultsContainer");
  if (results) {
    results.innerHTML =
      '<div style="color: var(--text-muted); font-size: 0.95rem; line-height: 1.6;">Preencha os dados e clique em “Gerar”.</div>';
  }
}

// =========================
// PriorizAI Tasks UI
// =========================
function createTaskItem(index) {
  const wrapper = document.createElement("div");
  wrapper.className = "task-item";

  wrapper.innerHTML = `
        <div class="task-item-header">
            <span class="task-number">Tarefa ${index + 1}</span>
            <button class="remove-task" type="button" title="Remover">×</button>
        </div>

        <div class="form-group">
            <label>Título</label>
            <input class="input task-title" placeholder="Ex.: Revisar proposta do cliente" />
        </div>

        <div class="form-group">
            <label>Contexto</label>
            <textarea class="textarea task-desc" placeholder="Detalhes importantes, dependências, prazo, etc."></textarea>
        </div>

        <div class="form-group">
            <label>Importância</label>
            <select class="select task-importance">
                <option value="alta">Alta</option>
                <option value="media" selected>Média</option>
                <option value="baixa">Baixa</option>
            </select>
        </div>

        <div class="form-group">
            <label>Tempo estimado</label>
            <select class="select task-time">
                <option value="curto">Curto</option>
                <option value="medio" selected>Médio</option>
                <option value="longo">Longo</option>
            </select>
        </div>
    `;

  wrapper.querySelector(".remove-task").addEventListener("click", () => {
    wrapper.remove();
    renumberTasks();
  });

  return wrapper;
}

function renumberTasks() {
  document.querySelectorAll("#taskList .task-item").forEach((item, i) => {
    const num = item.querySelector(".task-number");
    if (num) num.textContent = `Tarefa ${i + 1}`;
  });
}

function getTasksPayload() {
  const items = Array.from(document.querySelectorAll("#taskList .task-item"));
  const tasks = items
    .map((item) => ({
      title: item.querySelector(".task-title")?.value?.trim() || "",
      description: item.querySelector(".task-desc")?.value?.trim() || "",
      importance: item.querySelector(".task-importance")?.value || "media",
      time: item.querySelector(".task-time")?.value || "medio",
    }))
    .filter((t) => t.title);

  return tasks;
}

// =========================
// Renderers
// =========================
function renderError(message) {
  const results = $("resultsContainer");
  if (!results) return;
  results.innerHTML = `
        <div class="result-item" style="border-color: rgba(255, 78, 205, 0.35);">
            <div class="result-title" style="color: var(--accent-pink);">Erro</div>
            <div style="color: var(--text-secondary); margin-top: 0.35rem; line-height: 1.6;">
                ${escapeHtml(message)}
            </div>
        </div>
    `;
}

function renderPriorizAI(data) {
  const results = $("resultsContainer");
  if (!results) return;

  const ordered = Array.isArray(data?.ordered_tasks) ? data.ordered_tasks : [];
  if (!ordered.length) {
    results.innerHTML =
      '<div style="color: var(--text-muted); font-size: 0.95rem; line-height: 1.6;">Sem retorno válido.</div>';
    return;
  }

  results.innerHTML = ordered
    .map(
      (t) => `
        <div class="result-item">
            <div class="result-header">
                <div class="result-rank">${escapeHtml(t.position)}</div>
                <div class="result-title">${escapeHtml(t.task_title)}</div>
            </div>
        </div>
    `
    )
    .join("");
}

function renderCalmAI(data) {
  const results = $("resultsContainer");
  if (!results) return;

  const text = (data?.rewritten_text || "").trim();
  results.innerHTML = `
        <div class="result-item">
            <div class="result-title">Mensagem reescrita</div>
            <div style="margin-top: 0.65rem; color: var(--text-secondary); line-height: 1.7; white-space: pre-line;">
                ${escapeHtml(text || "Sem texto retornado.")}
            </div>
        </div>
    `;
}

function renderBriefAI(data) {
  const results = $("resultsContainer");
  if (!results) return;

  const summary = (data?.summary || "").trim();
  const bullets = Array.isArray(data?.bullets) ? data.bullets : [];

  const bulletsHtml =
    bullets.length > 0
      ? `<ul style="margin-top: 0.75rem; padding-left: 1.25rem; color: var(--text-secondary); line-height: 1.7;">
            ${bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}
         </ul>`
      : "";

  results.innerHTML = `
        <div class="result-item">
            <div class="result-title">Resumo</div>
            <div style="margin-top: 0.65rem; color: var(--text-secondary); line-height: 1.7; white-space: pre-line;">
                ${escapeHtml(summary || "Sem resumo retornado.")}
            </div>
            ${bulletsHtml}
        </div>
    `;
}

// =========================
// Actions
// =========================
async function processCurrentModule() {
  if (isBusy) return;

  try {
    setBusy(true);

    if (currentModule === "priorizai") {
      const name = $("priorizaiName")?.value?.trim() || "Castelão";
      const method = $("priorizaiMethod")?.value || "impact_effort";
      const tasks = getTasksPayload();
      if (!tasks.length) throw new Error("Adicione ao menos 1 tarefa com título.");

      const data = await callAPI(MODULE_ENDPOINTS.priorizai, { name, method, tasks });
      renderPriorizAI(data);
      return;
    }

    if (currentModule === "calmai") {
      const name = $("calmaiName")?.value?.trim() || "Castelão";
      const text = $("calmaiText")?.value?.trim() || "";
      if (!text) throw new Error("Informe sua mensagem.");

      const data = await callAPI(MODULE_ENDPOINTS.calmai, { name, text });
      renderCalmAI(data);
      return;
    }

    if (currentModule === "briefai") {
      const name = $("briefaiName")?.value?.trim() || "Castelão";
      const text = $("briefaiText")?.value?.trim() || "";
      if (!text) throw new Error("Informe o texto.");

      const data = await callAPI(MODULE_ENDPOINTS.briefai, { name, text });
      renderBriefAI(data);
      return;
    }
  } catch (err) {
    renderError(err?.message || "Erro ao processar.");
  } finally {
    setBusy(false);
  }
}

// =========================
// Init
// =========================
document.addEventListener("DOMContentLoaded", () => {
  // Tabs
  document.querySelectorAll(".module-tab").forEach((btn) => {
    btn.addEventListener("click", () => switchModule(btn.dataset.module));
  });

  // Default module
  switchModule("priorizai");
  updateProcessButtonLabel();

  // Task list start
  const list = $("taskList");
  if (list) {
    list.appendChild(createTaskItem(0));
    list.appendChild(createTaskItem(1));
  }

  // Add task
  $("addTaskBtn")?.addEventListener("click", () => {
    const list = $("taskList");
    if (!list) return;
    const index = list.querySelectorAll(".task-item").length;
    list.appendChild(createTaskItem(index));
    renumberTasks();
  });

  // Main button
  $("processBtn")?.addEventListener("click", processCurrentModule);
});
