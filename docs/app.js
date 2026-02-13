/* app.js - PriorizAI + CalmAI + BriefAI (novo layout) */
(() => {
  "use strict";

  // ========= CONFIG =========
  // Cole aqui a URL do seu Worker (sempre com https://)
  // Exemplo: https://priorizai.felipelcas.workers.dev
  const WORKER_BASE_URL = "https://priorizai.felipelcas.workers.dev";

  const MAX_TASKS = 10;
  const MIN_TASKS = 3;

  const MODULE_DESCRIPTIONS = {
    priorizai: "Você escreve suas tarefas. Eu coloco na melhor ordem e explico de um jeito fácil.",
    calmai: "Conte seu problema. A Diva do Caos vai te provocar, cutucar e te ajudar a ver de outro jeito.",
    briefai: "Cole qualquer texto bagunçado. Eu transformo em um briefing organizado e objetivo.",
  };

  const IMPORTANCE = [
    { label: "Quase não importa", value: 1 },
    { label: "Importa pouco", value: 2 },
    { label: "Importa", value: 3 },
    { label: "Importa muito", value: 4 },
    { label: "É crítico", value: 5 },
  ];

  const TIME_COST = [
    { label: "Menos de 10 min", value: 1 },
    { label: "10 a 30 min", value: 2 },
    { label: "30 min a 2h", value: 3 },
    { label: "2 a 6 horas", value: 4 },
    { label: "Mais de 6h", value: 5 },
  ];

  // ========= HELPERS =========
  const $ = (id) => document.getElementById(id);

  function normalizeBaseUrl(url) {
    const raw = String(url || "").trim();
    if (!raw) return "";
    const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return withProto.replace(/\/+$/, "");
  }

  function looksLikeInjection(text) {
    const t = String(text || "").toLowerCase();

    const xss = [
      "<script",
      "</script",
      "<iframe",
      "<object",
      "<embed",
      "<svg",
      "javascript:",
      "onerror=",
      "onload=",
    ];
    if (xss.some((p) => t.includes(p))) return true;

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

  function cleanText(text) {
    return String(text || "").replace(/\u0000/g, "").trim();
  }

  function requireSafeText(fieldName, value, { required = false, min = 0, max = 9999 } = {}) {
    const v = cleanText(value);

    if (required && !v) throw new Error(`Preencha: ${fieldName}.`);
    if (!required && !v) return "";

    if (v.length < min) throw new Error(`${fieldName} está muito curto.`);
    if (v.length > max) throw new Error(`${fieldName} passou do limite de caracteres.`);

    if (looksLikeInjection(v)) {
      throw new Error(`${fieldName} parece ter conteúdo perigoso. Ajuste o texto e tente de novo.`);
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

  function scrollToResults() {
    const section = $("resultsSection");
    if (!section) return;
    section.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ========= STATE =========
  let currentModule = "priorizai";
  let selectedMethod = "impact_effort";
  let taskCount = MIN_TASKS;

  // ========= API =========
  function getApiUrls() {
    const base = normalizeBaseUrl(WORKER_BASE_URL);
    return {
      base,
      prioritize: base ? `${base}/prioritize` : "",
      calmai: base ? `${base}/calmai` : "",
      briefai: base ? `${base}/briefai` : "",
    };
  }

  async function callWorkerJson(url, payload) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
      const msg = (data && (data.error || data.message)) || text || "Erro ao chamar o Worker.";
      throw new Error(msg);
    }
    return data || {};
  }

  // ========= UI: MODULE SWITCH =========
  function switchModule(module) {
    currentModule = module;

    document.querySelectorAll(".module-tab").forEach((t) => t.classList.remove("active"));
    document.querySelector(`.module-tab[data-module="${module}"]`)?.classList.add("active");

    document.querySelectorAll(".module-content").forEach((c) => c.classList.remove("active"));
    document.querySelector(`.module-content[data-module="${module}"]`)?.classList.add("active");

    const desc = $("moduleDescription");
    if (desc) desc.textContent = MODULE_DESCRIPTIONS[module] || "";

    const resultsSection = $("resultsSection");
    if (resultsSection) resultsSection.style.display = "none";
  }

  function initModuleTabs() {
    document.querySelectorAll(".module-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        const module = tab.dataset.module;
        if (!module) return;
        switchModule(module);
      });
    });
  }

  // ========= UI: METHOD =========
  function initMethodCards() {
    document.querySelectorAll(".method-card").forEach((card) => {
      card.addEventListener("click", () => {
        if (card.classList.contains("disabled")) return;

        document.querySelectorAll(".method-card").forEach((c) => c.classList.remove("active"));
        card.classList.add("active");

        const v = String(card.dataset.method || "").trim();
        selectedMethod = v === "impact_effort" ? "impact_effort" : "impact_effort";
      });
    });
  }

  // ========= UI: TASKS =========
  function optionHtml(list, selectedValue) {
    return list
      .map((o) => {
        const sel = o.value === selectedValue ? " selected" : "";
        return `<option value="${o.value}"${sel}>${escapeHtml(o.label)}</option>`;
      })
      .join("");
  }

  function addTaskElement(index) {
    const container = $("taskList");
    if (!container) return;

    const taskCard = document.createElement("div");
    taskCard.className = "task-card";
    taskCard.innerHTML = `
      <div class="task-number">Task ${String(index).padStart(2, "0")}</div>

      <div class="form-group">
        <label class="label">O que você vai fazer <span class="required">*</span></label>
        <input type="text" class="task-title" placeholder="Ex.: Enviar planilha para o fornecedor" required>
      </div>

      <div class="form-group">
        <label class="label">Explique bem <span class="required">*</span></label>
        <textarea class="task-desc" placeholder="Ex.: Enviar a planilha X para o fornecedor Y até 16h. Se atrasar, o pedido de amanhã pode travar." required></textarea>
      </div>

      <div class="input-row">
        <div class="form-group">
          <label class="label">Importância <span class="help-badge" title="Pense no impacto. Prazo aumenta a importância.">?</span></label>
          <select class="task-importance">
            ${optionHtml(IMPORTANCE, 3)}
          </select>
        </div>

        <div class="form-group">
          <label class="label">Tempo necessário <span class="help-badge" title="Tempo total estimado">?</span></label>
          <select class="task-time">
            ${optionHtml(TIME_COST, 2)}
          </select>
        </div>
      </div>
    `;

    container.appendChild(taskCard);
  }

  function updateTaskCounter() {
    const el = $("taskCounter");
    if (el) el.textContent = `${taskCount}/${MAX_TASKS}`;

    const btn = $("addTaskBtn");
    if (btn) btn.disabled = taskCount >= MAX_TASKS;
  }

  function initializeTasks() {
    const container = $("taskList");
    if (!container) return;

    container.innerHTML = "";
    for (let i = 1; i <= taskCount; i++) addTaskElement(i);
    updateTaskCounter();
  }

  function addTask() {
    if (taskCount >= MAX_TASKS) return;
    taskCount += 1;
    addTaskElement(taskCount);
    updateTaskCounter();
  }

  // ========= UI: RESULTS =========
  function showLoading(text) {
    const section = $("resultsSection");
    const container = $("resultsContainer");
    if (!section || !container) return;

    section.style.display = "block";
    container.innerHTML = `
      <div class="loading">
        <div class="spinner"></div>
        <div class="loading-text">${escapeHtml(text || "Processando com IA...")}</div>
      </div>
    `;
    scrollToResults();
  }

  function showError(message) {
    const section = $("resultsSection");
    const container = $("resultsContainer");
    if (!section || !container) return;

    section.style.display = "block";
    container.innerHTML = `
      <div class="result-empty">
        <div class="result-icon">❌</div>
        <p>${escapeHtml(message || "Erro ao processar. Tente novamente.")}</p>
      </div>
    `;
    scrollToResults();
  }

  function setBusy(isBusy) {
    const btn = $("processBtn");
    if (!btn) return;
    btn.disabled = !!isBusy;
    btn.style.opacity = isBusy ? "0.6" : "1";
  }

  function displayPriorizaiResults(data) {
    const container = $("resultsContainer");
    if (!container) return;

    const ordered = Array.isArray(data.ordered_tasks) ? data.ordered_tasks : [];

    const orderRows = ordered
      .map(
        (t) => `
      <tr>
        <td style="color: var(--accent-cyan); font-weight: 700;">${escapeHtml(t.position)}</td>
        <td>${escapeHtml(t.task_title)}</td>
      </tr>`
      )
      .join("");

    const orderTableHTML = `
      <table class="order-table">
        <thead>
          <tr>
            <th style="width: 80px;">Ordem</th>
            <th>Tarefa</th>
          </tr>
        </thead>
        <tbody>${orderRows || '<tr><td colspan="2">Sem itens</td></tr>'}</tbody>
      </table>
    `;

    const rankedListHTML = ordered
      .map((task) => {
        const keyPoints = Array.isArray(task.key_points) ? task.key_points : [];
        return `
          <div class="ranked-item">
            <div class="ranked-header">
              <div class="rank-number">${escapeHtml(task.position)}</div>
              <div class="rank-title">${escapeHtml(task.task_title)}</div>
            </div>
            ${task.explanation ? `<div class="rank-explanation">${escapeHtml(task.explanation)}</div>` : ""}
            ${
              keyPoints.length
                ? `<ul class="key-points">${keyPoints.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>`
                : ""
            }
            ${task.tip ? `<div class="rank-tip">${escapeHtml(task.tip)}</div>` : ""}
          </div>
        `;
      })
      .join("");

    const statHTML =
      data.estimated_time_saved_percent !== null && data.estimated_time_saved_percent !== undefined
        ? `<div class="stat-badge">📊 Tempo economizado: ${escapeHtml(data.estimated_time_saved_percent)}%</div>`
        : "";

    container.innerHTML = `
      <div class="result-header">
        <div class="result-message">${escapeHtml(data.friendly_message || "Priorização concluída")}</div>
        ${data.summary ? `<div class="result-summary">${escapeHtml(data.summary)}</div>` : ""}
        ${statHTML}
      </div>
      ${orderTableHTML}
      <div class="ranked-list">${rankedListHTML}</div>
    `;
  }

  function displayCalmaiResults(data) {
    const container = $("resultsContainer");
    if (!container) return;

    const reply = String(data.reply || "Sem resposta");
    const paragraphs = reply
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p style="margin-bottom: 1rem;">${escapeHtml(p)}</p>`)
      .join("");

    container.innerHTML = `
      <div class="result-header">
        <div class="result-message">💭 Diva do Caos responde</div>
      </div>
      <div class="calmai-response">${paragraphs || `<p>${escapeHtml(reply)}</p>`}</div>
    `;
  }

  function displayBriefaiResults(data) {
    const container = $("resultsContainer");
    if (!container) return;

    const missingInfo = Array.isArray(data.missingInfo) ? data.missingInfo : [];
    const nextSteps = Array.isArray(data.nextSteps) ? data.nextSteps : [];

    const missingInfoHTML = missingInfo.length
      ? `
        <div class="brief-section">
          <div class="brief-title">📌 Informações Faltando</div>
          <ul class="brief-list">
            ${missingInfo.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
          </ul>
        </div>`
      : "";

    const nextStepsHTML = nextSteps.length
      ? `
        <div class="brief-section">
          <div class="brief-title">🎯 Próximos Passos</div>
          <ul class="brief-list">
            ${nextSteps.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
          </ul>
        </div>`
      : "";

    container.innerHTML = `
      <div class="result-header">
        <div class="result-message">${escapeHtml(data.friendlyMessage || "Briefing gerado")}</div>
        ${data.summary ? `<div class="result-summary">${escapeHtml(data.summary)}</div>` : ""}
      </div>

      <div class="brief-section">
        <div class="brief-title">📄 Briefing Estruturado</div>
        <div class="brief-content">${escapeHtml(data.brief || "")}</div>
      </div>

      ${missingInfoHTML}
      ${nextStepsHTML}
    `;
  }

  // ========= ACTIONS =========
  function collectPriorizaiPayload() {
    const name = requireSafeText("Seu nome", $("userName")?.value, { required: true, min: 2, max: 60 });

    const cards = Array.from(document.querySelectorAll(".task-card"));
    const tasks = [];

    for (let i = 0; i < cards.length; i++) {
      const idx = i + 1;
      const card = cards[i];

      const titleRaw = cleanText(card.querySelector(".task-title")?.value);
      const descRaw = cleanText(card.querySelector(".task-desc")?.value);

      const isEmpty = !titleRaw && !descRaw;
      if (isEmpty) continue;

      const title = requireSafeText(`Tarefa ${idx} - título`, titleRaw, { required: true, min: 3, max: 80 });
      const description = requireSafeText(`Tarefa ${idx} - descrição`, descRaw, { required: true, min: 10, max: 800 });

      const impEl = card.querySelector(".task-importance");
      const timeEl = card.querySelector(".task-time");

      const importance = Number(impEl?.value);
      const time_cost = Number(timeEl?.value);

      const importance_label = impEl?.options?.[impEl.selectedIndex]?.text || "";
      const time_label = timeEl?.options?.[timeEl.selectedIndex]?.text || "";

      tasks.push({
        title,
        description,
        importance,
        time_cost,
        importance_label,
        time_label,
      });
    }

    if (tasks.length < MIN_TASKS) {
      throw new Error(`Preencha no mínimo ${MIN_TASKS} tarefas completas.`);
    }

    const { base } = getApiUrls();
    if (!base) throw new Error("WORKER_BASE_URL está vazio. Configure a URL do seu Worker no app.js.");

    return { name, method: selectedMethod, tasks };
  }

  async function processPriorizai() {
    showLoading("Processando com IA...");
    setBusy(true);

    try {
      const payload = collectPriorizaiPayload();
      const { prioritize } = getApiUrls();
      const data = await callWorkerJson(prioritize, payload);
      displayPriorizaiResults(data);
    } catch (err) {
      showError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function processCalmai() {
    showLoading("Processando com IA...");
    setBusy(true);

    try {
      const name = requireSafeText("Seu nome", $("calmaiUserName")?.value, { required: true, min: 2, max: 60 });
      const text = requireSafeText("Texto", $("calmaiText")?.value, { required: true, min: 10, max: 500 });

      const { calmai } = getApiUrls();
      const data = await callWorkerJson(calmai, { name, text });
      displayCalmaiResults(data);
    } catch (err) {
      showError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function processBriefai() {
    showLoading("Gerando o brief...");
    setBusy(true);

    try {
      const name = requireSafeText("Seu nome", $("briefaiUserName")?.value, { required: true, min: 2, max: 60 });
      const text = requireSafeText("Seu texto", $("briefaiText")?.value, { required: true, min: 20, max: 1500 });

      const { briefai } = getApiUrls();
      const data = await callWorkerJson(briefai, { name, text });
      displayBriefaiResults(data);
    } catch (err) {
      showError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onProcessClick() {
    if (currentModule === "priorizai") return processPriorizai();
    if (currentModule === "calmai") return processCalmai();
    if (currentModule === "briefai") return processBriefai();
  }

  // ========= INIT =========
  function init() {
    initModuleTabs();
    initMethodCards();
    initializeTasks();

    $("addTaskBtn")?.addEventListener("click", addTask);
    $("processBtn")?.addEventListener("click", onProcessClick);

    // estado inicial
    switchModule("priorizai");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
