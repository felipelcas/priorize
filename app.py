import json
import re
import html as html_lib
from pathlib import Path
from typing import Litera:contentReference[oaicite:4]{index=4}it as st
import streamlit.components.v1 as components
from pydantic import BaseModel, Field
from openai import OpenAI

# -----------------------------
# Tipos
# -----------------------------
Method = Literal["IMPACT_EFFORT", "RICE", "MOSCOW", "GUT"]

# -----------------------------
# Página
# -----------------------------
st.set_page_config(page_title="PriorizAI", page_icon="✅", layout="wide")


# -----------------------------
# Carregar HTML externo (CSS + links)
# -----------------------------
HTML_FILE = Path(__file__).parent / "frontend_priorizai.html"


def extract_between(text: str, start: str, end: str) -> str:
    m = re.search(re.escape(start) + r"(.*?)" + re.escape(end), text, flags=re.S | re.I)
    return m.group(1) if m else ""


def load_frontend_assets(html_path: Path) -> tuple[str, str]:
    raw = html_path.read_text(encoding="utf-8")

    # Pega o CSS do <style>...</style>
    css = extract_between(raw, "<style>", "</style>").strip()

    # Pega os <link ...> (fontes etc)
    links = "\n".join(re.findall(r"<link[^>]+>", raw, flags=re.I)).strip()

    return css, links


if not HTML_FILE.exists():
    st.error("Arquivo frontend_priorizai.html não encontrado ao lado do app.py.")
    st.stop()

html_css, html_links = load_frontend_assets(HTML_FILE)

# Injeta links (fonts) e CSS do HTML
# Observação: link tags no corpo funcionam para carregar fontes na prática.
st.markdown(html_links, unsafe_allow_html=True)

# Patch CSS para integrar com Streamlit (layout, fundo e widgets)
# Baseado no seu HTML (classes .container, .card, .card-title, .tooltip-icon, .task-item etc)
st.markdown(
    f"""
    <style>
      {html_css}

      /* Ajustes do Streamlit para ficar com a mesma “cara” do HTML */
      .block-container {{
        max-width: 1400px;
        padding-top: 1.25rem;
        padding-bottom: 1.25rem;
      }}

      /* Fundo parecido com o do HTML (Streamlit usa containers próprios) */
      [data-testid="stAppViewContainer"] {{
        background: linear-gradient(135deg, #0a0e1a 0%, #1e1b4b 50%, #0a0e1a 100%);
      }}
      [data-testid="stHeader"] {{ background: transparent; }}
      [data-testid="stToolbar"] {{ visibility: hidden; height: 0px; }}

      /* Esconde ícones/links de cabeçalho do Streamlit */
      a[href^="#"] {{ display: none !important; }}
      button[title*="link"], button[aria-label*="link"] {{ display:none !important; }}

      /* Inputs com estética do seu HTML */
      [data-baseweb="input"] > div,
      [data-baseweb="textarea"] > div,
      [data-baseweb="select"] > div {{
        background: rgba(15, 23, 42, 0.6) !important;
        border: 1px solid rgba(148, 163, 184, 0.1) !important;
        border-radius: 12px !important;
        box-shadow: none !important;
      }}
      [data-baseweb="input"] > div:focus-within,
      [data-baseweb="textarea"] > div:focus-within,
      [data-baseweb="select"] > div:focus-within {{
        border-color: #06b6d4 !important;
        box-shadow: 0 0 0 3px rgba(6, 182, 212, 0.3) !important;
      }}

      /* Botões estilo “btn” */
      div.stButton > button[kind="primary"] {{
        background: linear-gradient(135deg, #06b6d4, #0891b2) !important;
        color: #ffffff !important;
        border: none !important;
        border-radius: 12px !important;
        font-weight: 800 !important;
        padding: 0.9rem 1rem !important;
        box-shadow: 0 4px 20px rgba(6, 182, 212, 0.3) !important;
      }}
      div.stButton > button {{
        background: rgba(17, 24, 39, 0.6) !important;
        color: #f8fafc !important;
        border: 1px solid rgba(148, 163, 184, 0.1) !important;
        border-radius: 12px !important;
        font-weight: 700 !important;
        padding: 0.85rem 1rem !important;
      }}

      /* Tooltip ícone amarelo pequeno (mesma ideia do seu HTML .tooltip-icon) */
      .tooltip-icon {{
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        background: #fbbf24;
        color: #0a0e1a;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 800;
        cursor: help;
        margin-left: 6px;
        user-select: none;
        line-height: 16px;
      }}

      /* Alternância de cor de tarefa (Streamlit quebra nth-child, então usamos .alt) */
      .task-item.alt {{
        border-left-color: #fbbf24 !important;
      }}

      /* Títulos do form maiores */
      .big-label {{
        font-family: 'Outfit', sans-serif;
        font-size: 1.1rem;
        font-weight: 800;
        margin-bottom: 0.25rem;
      }}

      /* Aviso amarelo mais evidente */
      .info-banner {{
        font-size: 1rem !important;
        font-weight: 800 !important;
      }}

      /* Obrigatório com * vermelho */
      .req {{
        color: #ef4444;
        font-weight: 900;
        margin-left: 4px;
      }}

      hr {{
        border: none;
        border-top: 1px solid rgba(148, 163, 184, 0.15);
        margin: 1.25rem 0;
      }}
    </style>
    """,
    unsafe_allow_html=True,
)


def help_icon(text: str) -> str:
    tip = html_lib.escape(text, quote=True)
    return f"<span class='tooltip-icon' title='{tip}'>?</span>"


def scroll_to_top():
    components.html(
        """
        <script>
          const root = window.parent.document.querySelector(".main");
          if(root){ root.scrollTop = 0; }
          window.scrollTo(0,0);
        </script>
        """,
        height=0,
    )


# -----------------------------
# Modelos de resposta
# -----------------------------
class RankedItem(BaseModel):
    position: int = Field(ge=1)
    task_title: str
    explanation: str
    key_points: List[str]
    tip: str


class PriorizeResult(BaseModel):
    friendly_message: str
    method_used: Method
    estimated_time_saved_percent: int = Field(ge=0, le=80)
    summary: str
    ordered_tasks: List[RankedItem]


# -----------------------------
# Escalas (texto -> número)
# -----------------------------
IMPORTANCE = [
    ("Quase não muda nada", 1),
    ("Ajuda um pouco", 2),
    ("Ajuda bem", 3),
    ("Ajuda muito", 4),
    ("É muito importante agora", 5),
]

TIME_COST = [
    ("Menos de 10 min", 1),
    ("10 a 30 min", 2),
    ("30 min a 2 horas", 3),
    ("2 a 6 horas", 4),
    ("Mais de 6 horas", 5),
]


def labels(options):
    return [x[0] for x in options]


def to_num(options, selected_label: str) -> int:
    return int({lbl: num for (lbl, num) in options}[selected_label])


# -----------------------------
# OpenAI
# -----------------------------
def get_openai_client() -> OpenAI:
    api_key = None
    try:
        api_key = st.secrets.get("OPENAI_API_KEY")
    except Exception:
        api_key = None
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY não configurada nos Secrets do Streamlit Cloud.")
    return OpenAI(api_key=api_key)


def call_openai_prioritize(user_name: str, method: Method, tasks_payload: List[Dict]) -> PriorizeResult:
    client = get_openai_client()

    model = "gpt-4o-mini"
    try:
        model = st.secrets.get("OPENAI_MODEL", model)
    except Exception:
        pass

    system = (
        "Você é o PriorizAI. Fale como um colega de trabalho legal, simples e direto. "
        "O usuário tem 16 anos e pouca instrução. "
        "Use o nome do usuário e cite as tarefas para personalizar. "
        "Muito importante: use também a descrição para estimar tempo/complexidade e importância real. "
        "Se a escolha do usuário (ajuda/tempo) estiver incoerente com a descrição, ajuste sua análise "
        "sem julgar, e explique de forma gentil. "
        "Não invente fatos externos. Use só o que foi informado. "
        "Retorne no schema."
    )

    rule = (
        "Método Impacto e Esforço: faça primeiro o que é MAIS IMPORTANTE e leva MENOS TEMPO. "
        "Depois o que é muito importante mesmo se levar mais tempo. "
        "Por último, coisas pouco importantes e demoradas."
    )

    user = f"""
Nome: {user_name}
Método: {method}

Como aplicar:
{rule}

Tarefas (JSON):
{json.dumps(tasks_payload, ensure_ascii=False)}

Regras da resposta:
- Faça um check: compare AJUDA e TEMPO escolhidos com a DESCRIÇÃO.
- Se a descrição indicar tempo maior/menor, considere isso.
- Se a descrição indicar urgência (prazo/visita/entrega), considere isso.
- Retorne uma ordem clara.
- friendly_message: curto e personalizado.
- summary: 2 a 3 frases.
- Para cada tarefa: explanation (2 a 5 frases), key_points (2 a 4 itens), tip (1 frase).
- estimated_time_saved_percent: inteiro 0..80, realista.
"""

    resp = client.responses.parse(
        model=model,
        input=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        text_format=PriorizeResult,
    )
    return resp.output_parsed


# -----------------------------
# Estado
# -----------------------------
if "task_count" not in st.session_state:
    st.session_state.task_count = 3


# -----------------------------
# Header (com classes do HTML)
# -----------------------------
st.markdown(
    """
    <div class="container">
      <header>
        <h1 class="logo">PriorizAI</h1>
        <p class="tagline">Você escreve suas tarefas. Eu coloco na melhor ordem e explico de um jeito fácil.</p>
        <div class="privacy-note">
          <span class="privacy-icon">🔒</span>
          Nada fica salvo. Eu só uso o que você preencher agora.
        </div>
      </header>
    </div>
    """,
    unsafe_allow_html=True,
)

# Tabs (visual)
t1, t2, t3 = st.columns(3)
with t1:
    st.button("PriorizAI", type="primary", use_container_width=True)
with t2:
    st.button("Em breve 2", disabled=True, use_container_width=True)
with t3:
    st.button("Em breve 3", disabled=True, use_container_width=True)

st.write("")

left, right = st.columns([1, 1])

# -----------------------------
# Resultado (direita)
# -----------------------------
with right:
    st.markdown("<div class='card'>", unsafe_allow_html=True)
    st.markdown("<div class='card-title'>Resultado</div>", unsafe_allow_html=True)

    status_ph = st.empty()
    table_ph = st.empty()
    text_ph = st.empty()

    st.markdown("</div>", unsafe_allow_html=True)

# -----------------------------
# Entrada (esquerda)
# -----------------------------
with left:
    st.markdown("<div class='card'>", unsafe_allow_html=True)
    st.markdown("<div class='card-title'>Configuração</div>", unsafe_allow_html=True)

    st.markdown("<div class='big-label'>Seu nome<span class='req'>*</span></div>", unsafe_allow_html=True)
    user_name = st.text_input(
        "nome",
        label_visibility="collapsed",
        placeholder="Ex.: Felipe Castelão",
    )

    st.markdown("<div class='form-group'>", unsafe_allow_html=True)
    st.markdown("<label>Método de priorização</label>", unsafe_allow_html=True)
    st.markdown("<p class='hint-text'>Por enquanto, só o primeiro está liberado.</p>", unsafe_allow_html=True)
    st.markdown("</div>", unsafe_allow_html=True)

    # Toggles visíveis, só o primeiro habilitado
    m1, m2, m3, m4 = st.columns(4)
    with m1:
        st.button("Impacto e Esforço", type="primary", use_container_width=True)
        st.markdown(help_icon("Prioriza o que é mais importante e leva menos tempo."), unsafe_allow_html=True)
    with m2:
        st.button("RICE", disabled=True, use_container_width=True)
        st.markdown(help_icon("Método mais técnico. Vai liberar depois."), unsafe_allow_html=True)
    with m3:
        st.button("MoSCoW", disabled=True, use_container_width=True)
        st.markdown(help_icon("Separa em: obrigatório, importante, bom ter, não agora."), unsafe_allow_html=True)
    with m4:
        st.button("GUT", disabled=True, use_container_width=True)
        st.markdown(help_icon("Olha gravidade, urgência e tendência. Vai liberar depois."), unsafe_allow_html=True)

    method: Method = "IMPACT_EFFORT"

    st.markdown("<hr/>", unsafe_allow_html=True)

    st.markdown("<div class='card-title'>Tarefas</div>", unsafe_allow_html=True)
    st.markdown(
        "<p class='hint-text'>Dica: escreva prazo, quem depende e o que acontece se atrasar. Quanto mais claro, melhor.</p>",
        unsafe_allow_html=True,
    )
    st.markdown("<div class='info-banner'>Preencha no mínimo 3 tarefas completas.</div>", unsafe_allow_html=True)

    tasks_raw = []
    for idx in range(1, st.session_state.task_count + 1):
        alt = " alt" if idx % 2 == 0 else ""
        st.markdown(f"<div class='task-item{alt}'>", unsafe_allow_html=True)
        st.markdown(f"<div class='task-header'>Tarefa {idx}</div>", unsafe_allow_html=True)

        st.markdown("O que você vai fazer <span class='req'>*</span>", unsafe_allow_html=True)
        title = st.text_input(
            "t",
            key=f"title_{idx}",
            label_visibility="collapsed",
            placeholder="Ex.: Enviar a planilha do mês para o fornecedor até 16h",
        )

        st.markdown("Explique bem <span class='req'>*</span>", unsafe_allow_html=True)
        desc = st.text_area(
            "d",
            key=f"desc_{idx}",
            label_visibility="collapsed",
            height=90,
            placeholder=(
                "Ex.: Mandar a planilha X para o fornecedor Y até 16h. "
                "Se atrasar, pode travar o pedido de amanhã e eu fico sem material."
            ),
        )

        c1, c2 = st.columns(2)
        with c1:
            st.markdown(
                f"Quanto isso ajuda você {help_icon('Pense no que você ganha ou evita. Se tem prazo, marque mais alto.')}",
                unsafe_allow_html=True,
            )
            imp_lbl = st.selectbox(
                "imp",
                options=labels(IMPORTANCE),
                key=f"imp_{idx}",
                label_visibility="collapsed",
                index=2,
            )

        with c2:
            st.markdown(
                f"Quanto tempo isso leva {help_icon('Escolha o tempo total que você acha que vai gastar de verdade.')}",
                unsafe_allow_html=True,
            )
            time_lbl = st.selectbox(
                "tm",
                options=labels(TIME_COST),
                key=f"time_{idx}",
                label_visibility="collapsed",
                index=1,
            )

        st.markdown("</div>", unsafe_allow_html=True)

        tasks_raw.append(
            {
                "title": (title or "").strip(),
                "description": (desc or "").strip(),
                "importance_label": imp_lbl,
                "time_label": time_lbl,
                "importance": to_num(IMPORTANCE, imp_lbl),
                "time_cost": to_num(TIME_COST, time_lbl),
            }
        )

    st.write("")
    add1, add2 = st.columns([1, 1])
    with add1:
        if st.button("➕ Adicionar tarefa", use_container_width=True, disabled=(st.session_state.task_count >= 10)):
            st.session_state.task_count += 1
            st.rerun()
    with add2:
        st.caption(f"{st.session_state.task_count}/10")

    filled = [t for t in tasks_raw if t["title"] and t["description"]]
    can_run = bool(user_name.strip()) and (len(filled) >= 3)

    st.write("")
    run = st.button("✨ Priorizar com IA", type="primary", use_container_width=True, disabled=not can_run)

    st.markdown("</div>", unsafe_allow_html=True)

# -----------------------------
# Rodar IA + resultado
# -----------------------------
if run and can_run:
    scroll_to_top()
    status_ph.info("Priorizando a ordem...")

    payload = [
        {
            "title": t["title"],
            "description": t["description"],
            "user_chosen_importance": t["importance"],
            "user_chosen_time_cost": t["time_cost"],
            "importance_label": t["importance_label"],
            "time_label": t["time_label"],
            "note": "Use também a descrição para corrigir ajuda e tempo estimado, se fizer sentido.",
        }
        for t in filled
    ]

    try:
        result = call_openai_prioritize(user_name.strip(), method, payload)

        status_ph.empty()
        table_ph.table([{"Ordem": i.position, "Tarefa": i.task_title} for i in result.ordered_tasks])

        text_ph.success(result.friendly_message)
        text_ph.write(result.summary)
        text_ph.write(f"Tempo economizado (estimado): **{result.estimated_time_saved_percent}%**")
        text_ph.write("")

        for item in result.ordered_tasks:
            text_ph.markdown(f"**{item.position}. {item.task_title}**")
            text_ph.write(item.explanation)
            for p in item.key_points:
                text_ph.write(f"- {p}")
            text_ph.caption(item.tip)
            text_ph.write("")

    except Exception as e:
        status_ph.empty()
        table_ph.empty()
        text_ph.error(str(e))
