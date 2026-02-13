// ===============================
// CONFIG
// ===============================
// Cole a URL do seu Worker (SEM barra no final).
// Ex.: https://priorizai.felipelcas.workers.dev
const WORKER_BASE_URL = "https://priorizai.felipelcas.workers.dev";

function normalizeBaseUrl(url) {
  if (!url || typeof url !== "string") return "";
  let u = url.trim();
  while (u.endsWith("/")) u = u.slice(0, -1);
  return u;
}

const API_PRIORITIZE = `${normalizeBaseUrl(WORKER_BASE_URL)}/prioritize`;
const API_CALMAI = `${normalizeBaseUrl(WORKER_BASE_URL)}/calmai`;

// ===============================
// SECURITY: anti "injeção SQL" (validação simples)
// ===============================
// Observação: não existe SQL aqui, mas você pediu bloqueio.
// Eu faço uma validação bem conservadora, no front.
function looksLikeSqlInjection(text) {
  const t = String(text || "").toLowerCase();

  // padrões típicos
  const patterns = [
    "--",
    "/*",
    "*/",
    ";",
    " or ",
    " and ",
    " union ",
    " select ",
    " insert ",
    " update ",
    " delete ",
    " drop ",
    " alter ",
    " create ",
    " truncate ",
    " xp_",
    "1=1",
    "' or",
    "\" or",
  ];

  return patterns.some((p) => t.includes(p));
}

function requireSafeText(label, value, { maxLen = 500, required = true } = {}) {
  const v = String(value || "").trim();

  if (required && !v) {
    alert(`Preencha: ${label}.`);
    return null;
  }

  if (v.length > maxLen) {
    alert(`${label}: limite de ${maxLen} caracteres.`);
    return null;
  }

  if (looksLikeSqlInjection(v)) {
    alert(
      `${label}: achei algo que parece código. Remova coisas como ponto e vírgula, "--", ou palavras tipo SELECT / DROP / UNION.`
    );
    return null;
  }

  return v;
}

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ===============================
// TABS
// ===============================
function setActiveTab(tabName) {
  document.querySelectorAll(".tab-btn[data-tab]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });

  const viewPri = document.getElementById("viewPriorizai");
  const viewCalm = document.getElementById("viewCalmai");

  if (viewPri) viewPri.style.display = tabName === "priorizai" ? "" : "none";
  if (viewCalm) viewCalm.style.display = tabName === "calmai" ? "" : "none";

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function initTabs() {
  document.querySelectorAll(".tab-btn[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
  });
}

// ===============================
// PRIORIZAI
// ===============================
let taskCount = 3;
const MAX_TASKS = 10;

function getActiveMethod() {
  const active = document.querySelector("#viewPriorizai .method-card.active");
  const method = active?.dataset?.method || "impact";

  if (method === "impact") return "IMPACT_EFFORT";
  if (method === "rice") return "RICE";
  if (method === "moscow") return "MOSCOW";
  if (method === "gut") return "GUT";
  return "IMPACT_EFFORT";
}

function addTaskElement(number) {
  const container = document.getElementById("tasksContainer");
  if (!container) return;

  const taskItem = document.createElement("div");
  taskItem.className = "task-item";

  taskItem.innerHTML = `
    <div class="task-header">Tarefa ${number}</div>

    <div class="form-group">
      <label>O que você vai fazer <span class="required">*</span></label>
      <input type="text" class="task-title" placeholder="Ex.: Enviar a planilha para o fornecedor" required>
    </div>

    <div class="form-group">
      <label>Explique bem <span class="required">*</span></label>
      <textarea class="task-desc" placeholder="Ex.: Enviar a planilha X para o fornecedor Y até 16h. Se atrasar, o pedido de amanhã pode travar." required></textarea>
    </div>

    <div class="two-col">
      <div class="form-group">
        <label>
          Quão importante isso é agora
          <span class="tooltip-icon" title="Pense no que você ganha ou evita. Se tem prazo ou alguém depende, sobe a importância.">?</span>
        </label>
        <select class="task-importance">
          <option value="1">Quase não muda nada</option>
          <option value="2">Ajuda um pouco</option>
          <option value="3" selected>Ajuda bem</option>
          <option value="4">Ajuda muito</option>
          <option value="5">É muito importante agora</option>
        </select>
      </div>

      <div class="form-group">
        <label>
          Quanto tempo isso leva
          <span class="tooltip-icon" title="Escolha o tempo total. Se tiver várias etapas, some tudo.">?</span>
        </label>
        <select class="task-time">
          <option value="1">Menos de 10 min</option>
          <option value="2" selected>10 a 30 min</option>
          <option value="3">30 min a 2 horas</option>
          <option value="4">2 a 6 horas</option>
          <option value="5">Mais de 6 horas</option>
        </select>
      </div>
    </div>
  `;

  container.appendChild(taskItem);
}

function updateTaskCounter() {
  const counter = document.getElementById("taskCounter");
  const btn = document.getElementById("addTaskBtn");
  if (counter) counter.textContent = `${taskCount}/${MAX_TASKS}`;
  if (btn) btn.disabled = taskCount >= MAX_TASKS;
}

function initializeTasks() {
  const container = document.getElementById("tasksContainer");
  if (!container) return;
  container.innerHTML = "";
  for (let i = 1; i <= taskCount; i++) addTaskElement(i);
  updateTaskCounter();
}

function validatePriorizaiForm() {
  const base = normalizeBaseUrl(WORKER_BASE_URL);
  if (!base || !base.startsWith("https://")) {
    alert("Configure o WORKER_BASE_URL com https e sem barra no final.");
    return false;
  }

  const rawName = document.getElementById("userName")?.value || "";
  const userName = requireSafeText("Seu nome", rawName, { maxLen: 60, required: true });
  if (!userName) return false;

  const tasks = Array.from(document.querySelectorAll("#viewPriorizai .task-item"));

  const complete = tasks.filter((task) => {
    const title = task.querySelector(".task-title")?.value?.trim() || "";
    const desc = task.querySelector(".task-desc")?.value?.trim() || "";
    return title && desc;
  });

  if (complete.length < 3) {
    alert("Preencha no mínimo 3 tarefas completas (título e descrição).");
    return false;
  }

  // validação anti-injeção em tarefas
  for (const task of complete) {
    const title = requireSafeText("Título da tarefa", task.querySelector(".task-title")?.value, { maxLen: 100, required: true });
    if (!title) return false;

    const desc = requireSafeText("Descrição da tarefa", task.querySelector(".task-desc")?.value, { maxLen: 400, required: true });
    if (!desc) return false;
  }

  return true;
}

function collectPriorizaiData() {
  const rawName = document.getElementById("userName")?.value || "";
  const userName = String(rawName).trim();
  const method = getActiveMethod();

  const tasks = Array.from(document.querySelectorAll("#viewPriorizai .task-item"))
    .map((task) => ({
      title: (task.querySelector(".task-title")?.value || "").trim(),
      description: (task.querySelector(".task-desc")?.value || "").trim(),
      importance: parseInt(task.querySelector(".task-importance")?.value || "3", 10),
      time: parseInt(task.querySelector(".task-time")?.value || "2", 10),
    }))
    .filter((t) => t.title && t.description);

  return { userName, method, tasks };
}

function showPriorizaiLoading() {
  const container = document.getElementById("resultsContainer");
  if (!container) return;

  container.innerHTML = `
    <div class="loading">
      <div class="spinner"></div>
      <div class="loading-text">Priorizando a ordem...</div>
    </div>
  `;
}

function showPriorizaiError(message) {
  const container = document.getElementById("resultsContainer");
  if (!container) return;

  container.innerHTML = `
    <div class="result-empty">
      <div class="result-empty-icon">❌</div>
      <p>${escapeHtml(message || "Ops. Algo deu errado.")}</p>
    </div>
  `;
}

async function callApi(url, payload) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }

  if (!resp.ok) {
    const msg = (json && (json.error || json.message)) ? (json.error || json.message) : text;
    throw new Error(msg || `Erro HTTP ${resp.status}`);
  }

  return json || {};
}

function buildOrderTable(rankedTasks) {
  const rows = rankedTasks
    .map(
      (t) => `
      <tr>
        <td style="color: var(--accent-primary); font-weight: 800;">${t.position}</td>
        <td>${escapeHtml(t.title)}</td>
      </tr>
    `
    )
    .join("");

  return `
    <table class="order-table">
      <thead>
        <tr>
          <th style="width: 90px;">Ordem</th>
          <th>Tarefa</th>
        </tr>
      </thead>
      <tbody>
        ${rows || `<tr><td colspan="2">Sem itens para mostrar.</td></tr>`}
      </tbody>
    </table>
  `;
}

function normalizePriorResults(raw) {
  const friendlyMessage = raw.friendlyMessage ?? raw.friendly_message ?? "";
  const summary = raw.summary ?? "";
  const estimatedTimeSaved =
    raw.estimatedTimeSaved ??
    raw.estimated_time_saved_percent ??
    raw.estimatedTimeSavedPercent ??
    0;

  const list = raw.rankedTasks ?? raw.ordered_tasks ?? raw.orderedTasks ?? [];
  const rankedTasks = (Array.isArray(list) ? list : []).map((t, idx) => ({
    position: t.position ?? (idx + 1),
    title: t.title ?? t.task_title ?? t.taskTitle ?? "",
    explanation: t.explanation ?? "",
    keyPoints: t.keyPoints ?? t.key_points ?? [],
    tip: t.tip ?? "",
  }));

  return { friendlyMessage, summary, estimatedTimeSaved, rankedTasks };
}

function displayPriorizaiResults(raw) {
  const container = document.getElementById("resultsContainer");
  if (!container) return;

  const results = normalizePriorResults(raw);

  const rankedListHTML = results.rankedTasks
    .map(
      (task) => `
      <div class="ranked-item">
        <div class="ranked-header">
          <div class="rank-number">${task.position}</div>
          <div class="rank-title">${escapeHtml(task.title)}</div>
        </div>
        <div class="rank-explanation">${escapeHtml(task.explanation)}</div>
        <ul class="key-points">
          ${(task.keyPoints || []).map((p) => `<li>${escapeHtml(p)}</li>`).join("")}
        </ul>
        <div class="rank-tip">${escapeHtml(task.tip)}</div>
      </div>
    `
    )
    .join("");

  container.innerHTML = `
    <div class="result-header">
      <div class="result-message">${escapeHtml(results.friendlyMessage || "Aqui vai sua ordem de execução.")}</div>
      <div class="result-summary">${escapeHtml(results.summary || "")}</div>
      <div class="result-stat">📊 Tempo economizado estimado: ${Number(results.estimatedTimeSaved || 0)}%</div>
    </div>
    ${buildOrderTable(results.rankedTasks)}
    <div class="ranked-list">${rankedListHTML}</div>
  `;

  if (window.innerWidth <= 1024) {
    container.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function initPriorizai() {
  const addBtn = document.getElementById("addTaskBtn");
  const runBtn = document.getElementById("prioritizeBtn");

  if (addBtn) {
    addBtn.addEventListener("click", () => {
      if (taskCount < MAX_TASKS) {
        taskCount++;
        addTaskElement(taskCount);
        updateTaskCounter();
      }
    });
  }

  if (runBtn) {
    runBtn.addEventListener("click", async () => {
      if (!validatePriorizaiForm()) return;

      window.scrollTo({ top: 0, behavior: "smooth" });

      showPriorizaiLoading();

      try {
        const data = collectPriorizaiData();
        const res = await callApi(API_PRIORITIZE, data);
        displayPriorizaiResults(res);
      } catch (err) {
        showPriorizaiError(String(err?.message || "Erro na IA."));
      }
    });
  }

  document.querySelectorAll("#viewPriorizai .method-card:not(.disabled)").forEach((card) => {
    card.addEventListener("click", () => {
      document.querySelectorAll("#viewPriorizai .method-card").forEach((c) => c.classList.remove("active"));
      card.classList.add("active");
    });
  });

  initializeTasks();
}

// ===============================
// CALMAI
// ===============================
function updateCalmCounter() {
  const ta = document.getElementById("calmText");
  const count = document.getElementById("calmCount");
  if (!ta || !count) return;
  count.textContent = String((ta.value || "").length);
}

function showCalmLoading() {
  const container = document.getElementById("calmResultsContainer");
  if (!container) return;

  container.innerHTML = `
    <div class="loading">
      <div class="spinner"></div>
      <div class="loading-text">A Diva do Caos está lendo isso... 💅</div>
    </div>
  `;
}

function showCalmError(message) {
  const container = document.getElementById("calmResultsContainer");
  if (!container) return;

  container.innerHTML = `
    <div class="result-empty">
      <div class="result-empty-icon">❌</div>
      <p>${escapeHtml(message || "Ops. Algo deu errado.")}</p>
    </div>
  `;
}

function displayCalmResult(raw) {
  const container = document.getElementById("calmResultsContainer");
  if (!container) return;

  const reply = raw.reply ?? raw.message ?? raw.text ?? "";

  container.innerHTML = `
    <div class="result-header">
      <div class="result-message">Diva do Caos</div>
      <div class="result-summary">${escapeHtml(reply || "Não veio resposta. Tenta de novo.")}</div>
    </div>
  `;

  if (window.innerWidth <= 1024) {
    container.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function initCalmai() {
  const ta = document.getElementById("calmText");
  const btn = document.getElementById("calmBtn");

  if (ta) {
    ta.addEventListener("input", updateCalmCounter);
    updateCalmCounter();
  }

  if (btn) {
    btn.addEventListener("click", async () => {
      const base = normalizeBaseUrl(WORKER_BASE_URL);
      if (!base || !base.startsWith("https://")) {
        alert("Configure o WORKER_BASE_URL com https e sem barra no final.");
        return;
      }

      const nameRaw = document.getElementById("calmName")?.value || "";
      const textRaw = document.getElementById("calmText")?.value || "";

      const userName = requireSafeText("Seu nome", nameRaw, { maxLen: 60, required: false });
      const problemText = requireSafeText("Seu problema", textRaw, { maxLen: 500, required: true });
      if (!problemText) return;

      window.scrollTo({ top: 0, behavior: "smooth" });
      showCalmLoading();

      try {
        const payload = { userName: userName || "", text: problemText };
        const res = await callApi(API_CALMAI, payload);
        displayCalmResult(res);
      } catch (err) {
        showCalmError(String(err?.message || "Erro na IA."));
      }
    });
  }
}

// ===============================
// BOOT
// ===============================
document.addEventListener("DOMContentLoaded", () => {
  initTabs();
  initPriorizai();
  initCalmai();
});
