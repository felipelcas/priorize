import json
import time
import streamlit as st
import streamlit.components.v1 as components
from typing import Literal, List, Dict
from pydantic import BaseModel, Field
from openai import OpenAI

Method = Literal["IMPACT_EFFORT", "RICE", "MOSCOW", "GUT"]

# -----------------------------
# Página
# -----------------------------
st.set_page_config(page_title="PrioriZÉ", page_icon="✅", layout="wide")

st.markdown(
    """
    <style>
      .block-container { padding-top: 1.0rem; padding-bottom: 1.0rem; max-width: 1100px; }
      [data-testid="stAppViewContainer"] {
        background: radial-gradient(1200px 600px at 30% 10%, #142045 0%, #0b1220 55%);
      }
      [data-testid="stHeader"] { background: transparent; }

      .card {
        background: rgba(15,23,42,.75);
        border: none;
        border-radius: 14px;
        padding: 12px;
      }

      .title { font-size: 18px; font-weight: 900; margin: 0 0 6px 0; }
      .section { font-size: 15px; font-weight: 900; margin: 10px 0 6px 0; }
      .tiny { color: #cbd5e1; font-size: 13px; margin: 0 0 6px 0; }
      .warn { color: #fb7185; font-size: 13px; margin-top: 6px; }
      .req { color: #ef4444; font-weight: 900; }

      /* Tarefas com cores alternadas */
      .task-a {
        background: rgba(17,28,54,.85);
        border-radius: 14px;
        padding: 10px;
        margin-bottom: 10px;
        border-left: 4px solid rgba(37,99,235,.75);
      }
      .task-b {
        background: rgba(17,28,54,.60);
        border-radius: 14px;
        padding: 10px;
        margin-bottom: 10px;
        border-left: 4px solid rgba(34,197,94,.55);
      }

      /* Widgets sem borda forte */
      input, textarea { box-shadow: none !important; }
      [data-baseweb="input"] > div,
      [data-baseweb="textarea"] > div,
      [data-baseweb="select"] > div {
        border: none !important;
        box-shadow: none !important;
        background: rgba(2,6,23,.45) !important;
        border-radius: 12px !important;
      }
      [data-baseweb="input"] > div:focus-within,
      [data-baseweb="textarea"] > div:focus-within,
      [data-baseweb="select"] > div:focus-within {
        outline: none !important;
        box-shadow: none !important;
        border: none !important;
      }

      /* Botões */
      div.stButton > button[kind="primary"] {
        background: #2563eb !important;
        color: #ffffff !important;
        border: none !important;
        border-radius: 12px !important;
        font-weight: 900 !important;
        padding: 0.65rem 0.9rem !important;
      }
      div.stButton > button {
        border-radius: 12px !important;
        font-weight: 800 !important;
        border: none !important;
        padding: 0.60rem 0.9rem !important;
      }

      hr { border: none; border-top: 1px solid rgba(255,255,255,0.08); margin: 10px 0; }
    </style>
    """,
    unsafe_allow_html=True,
)

# -----------------------------
# Modelos de resposta (Structured Output)
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
# Escalas simples, servem para qualquer tarefa
# -----------------------------
HELP_YOU = [
    ("Quase não muda nada", 1),
    ("Ajuda um pouco", 2),
    ("Ajuda bem", 3),
    ("Ajuda muito", 4),
    ("Resolve um problemão", 5),
]
TIME_ENERGY = [
    ("Bem rápido e leve", 1),
    ("Rápido", 2),
    ("Normal", 3),
    ("Demorado", 4),
    ("Muito demorado e pesado", 5),
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
        "Você é o PrioriZÉ. Fale como um colega legal, simples e direto. "
        "Pense em um usuário de 16 anos. "
        "Use o nome do usuário e cite tarefas para personalizar. "
        "Use o texto da descrição para conferir se a pessoa escolheu 'ajuda' e 'tempo' certo. "
        "Se estiver incoerente, ajuste sua análise e explique com cuidado, sem bronca. "
        "Estime o tempo normal de cada tarefa com base na descrição e no tipo de tarefa. "
        "Não invente fatos externos. Use só o que foi informado. "
        "Retorne no schema."
    )

    rule = (
        "Método Impacto e Esforço (aqui chamado Ajuda e Tempo): "
        "primeiro o que AJUDA MUITO e toma POUCO TEMPO. "
        "Depois o que ajuda muito mesmo se demorar mais. "
        "Evite o que ajuda pouco e demora muito."
    )

    user = f"""
Nome: {user_name}
Método: {method}

Como aplicar:
{rule}

Tarefas (JSON):
{json.dumps(tasks_payload, ensure_ascii=False)}

Regras da resposta:
- Antes de ordenar, faça um 'check' mental: compare escolhas do usuário com a descrição.
- Se a descrição indicar que é mais demorado ou mais importante do que a escolha, considere isso na ordem.
- summary: 2 a 3 frases.
- Para cada tarefa: explanation (2 a 5 frases, pode citar tempo normal), key_points (2 a 4 itens), tip (1 frase).
- estimated_time_saved_percent: inteiro 0..80, realista.
"""

    resp = client.responses.parse(
        model=model,
        input=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        text_format=PriorizeResult,
    )
    return resp.output_parsed

def scroll_to_top():
    components.html(
        """
        <script>
          var body = window.parent.document.querySelector(".main");
          if(body){ body.scrollTop = 0; }
          window.scrollTo(0,0);
        </script>
        """,
        height=0,
    )

# -----------------------------
# Estado
# -----------------------------
if "task_count" not in st.session_state:
    st.session_state.task_count = 3
if "last_result" not in st.session_state:
    st.session_state.last_result = None
if "last_error" not in st.session_state:
    st.session_state.last_error = None

# -----------------------------
# Cabeçalho
# -----------------------------
st.markdown('<div class="title">PrioriZÉ</div>', unsafe_allow_html=True)
st.write("Você escreve suas tarefas. Eu coloco na melhor ordem e digo o porquê.")
st.caption("Nada fica salvo. Eu só uso o que você preencher agora.")

st.write("")
top1, top2, top3 = st.columns(3)
with top1:
    st.button("PrioriZÉ", type="primary", use_container_width=True)
with top2:
    st.button("Em breve 2", disabled=True, use_container_width=True)
with top3:
    st.button("Em breve 3", disabled=True, use_container_width=True)

st.write("")

# -----------------------------
# Layout principal
# -----------------------------
left, right = st.columns([1, 1])

# Preparar placeholders do resultado
with right:
    st.markdown('<div class="card">', unsafe_allow_html=True)
    st.markdown('<div class="section">Resultado</div>', unsafe_allow_html=True)
    status_ph = st.empty()
    table_ph = st.empty()
    text_ph = st.empty()
    st.markdown("</div>", unsafe_allow_html=True)

# -----------------------------
# Entrada
# -----------------------------
with left:
    st.markdown('<div class="card">', unsafe_allow_html=True)

    st.markdown('<div class="section">Seu nome <span class="req">*</span></div>', unsafe_allow_html=True)
    user_name = st.text_input("nome", label_visibility="collapsed", placeholder="Ex.: Castelão")

    st.markdown('<div class="section">Método de priorização</div>', unsafe_allow_html=True)
    st.markdown('<div class="tiny">Os outros métodos aparecem, mas ainda estão travados.</div>', unsafe_allow_html=True)

    # Toggles visíveis, só o primeiro habilitado, com interrogação
    c1, c2, c3, c4 = st.columns(4)

    with c1:
        b1, q1 = st.columns([0.84, 0.16])
        with b1:
            st.button("Ajuda e Tempo", type="primary", use_container_width=True)
        with q1:
            with st.popover("?", use_container_width=True):
                st.write("Escolha o que mais te ajuda e toma menos tempo primeiro.")

    with c2:
        b2, q2 = st.columns([0.84, 0.16])
        with b2:
            st.button("RICE", disabled=True, use_container_width=True)
        with q2:
            with st.popover("?", use_container_width=True):
                st.write("Método mais técnico. Vai ficar disponível depois.")

    with c3:
        b3, q3 = st.columns([0.84, 0.16])
        with b3:
            st.button("MoSCoW", disabled=True, use_container_width=True)
        with q3:
            with st.popover("?", use_container_width=True):
                st.write("Divide em: obrigatório, importante, bom ter, não agora.")

    with c4:
        b4, q4 = st.columns([0.84, 0.16])
        with b4:
            st.button("GUT", disabled=True, use_container_width=True)
        with q4:
            with st.popover("?", use_container_width=True):
                st.write("Olha gravidade, urgência e tendência. Disponível depois.")

    method: Method = "IMPACT_EFFORT"

    st.markdown("<hr/>", unsafe_allow_html=True)

    st.markdown('<div class="section">Tarefas</div>', unsafe_allow_html=True)
    st.markdown('<div class="tiny">Preencha no mínimo 3 tarefas completas.</div>', unsafe_allow_html=True)

    tasks_raw = []
    for idx in range(1, st.session_state.task_count + 1):
        wrap_class = "task-a" if idx % 2 == 1 else "task-b"

        # Primeiras 3 abertas. Extras ficam recolhidas.
        if idx <= 3:
            container = st.container()
            with container:
                st.markdown(f"<div class='{wrap_class}'>", unsafe_allow_html=True)

                st.markdown(f"<div class='tiny'><b>Tarefa {idx}</b></div>", unsafe_allow_html=True)

                st.markdown("O que você vai fazer <span class='req'>*</span>", unsafe_allow_html=True)
                title = st.text_input("t", key=f"title_{idx}", label_visibility="collapsed", placeholder="Ex.: Lavar o banheiro")

                st.markdown("Explique rápido <span class='req'>*</span>", unsafe_allow_html=True)
                desc = st.text_area(
                    "d",
                    key=f"desc_{idx}",
                    label_visibility="collapsed",
                    placeholder="Ex.: Limpar pia, vaso e chão. Deixar ok.",
                    height=80,
                )

                r1, r2 = st.columns(2)
                with r1:
                    lab, pop = st.columns([0.85, 0.15])
                    with lab:
                        st.markdown("Quanto isso ajuda você", unsafe_allow_html=True)
                    with pop:
                        with st.popover("?", use_container_width=True):
                            st.write("Pense no quanto isso resolve um problema ou te deixa mais tranquilo.")
                    help_lbl = st.selectbox("help", options=labels(HELP_YOU), key=f"help_{idx}", label_visibility="collapsed")

                with r2:
                    lab, pop = st.columns([0.85, 0.15])
                    with lab:
                        st.markdown("Quanto tempo e energia isso pede", unsafe_allow_html=True)
                    with pop:
                        with st.popover("?", use_container_width=True):
                            st.write("Pense no tempo e no cansaço. A descrição também vai ajudar a IA a ajustar isso.")
                    time_lbl = st.selectbox("time", options=labels(TIME_ENERGY), key=f"time_{idx}", label_visibility="collapsed")

                st.markdown("</div>", unsafe_allow_html=True)

        else:
            with st.expander(f"Tarefa extra {idx}", expanded=False):
                st.markdown(f"<div class='{wrap_class}'>", unsafe_allow_html=True)

                st.markdown("O que você vai fazer <span class='req'>*</span>", unsafe_allow_html=True)
                title = st.text_input("t", key=f"title_{idx}", label_visibility="collapsed", placeholder="Ex.: Enviar mensagem de parabéns")

                st.markdown("Explique rápido <span class='req'>*</span>", unsafe_allow_html=True)
                desc = st.text_area(
                    "d",
                    key=f"desc_{idx}",
                    label_visibility="collapsed",
                    placeholder="Ex.: Mandar uma mensagem curta e educada.",
                    height=80,
                )

                r1, r2 = st.columns(2)
                with r1:
                    st.markdown("Quanto isso ajuda você", unsafe_allow_html=True)
                    help_lbl = st.selectbox("help", options=labels(HELP_YOU), key=f"help_{idx}", label_visibility="collapsed")
                with r2:
                    st.markdown("Quanto tempo e energia isso pede", unsafe_allow_html=True)
                    time_lbl = st.selectbox("time", options=labels(TIME_ENERGY), key=f"time_{idx}", label_visibility="collapsed")

                st.markdown("</div>", unsafe_allow_html=True)

        tasks_raw.append(
            {
                "title": (title or "").strip(),
                "description": (desc or "").strip(),
                "help_label": help_lbl,
                "time_label": time_lbl,
                "help": to_num(HELP_YOU, help_lbl),
                "time": to_num(TIME_ENERGY, time_lbl),
            }
        )

    st.write("")
    a1, a2 = st.columns([1, 1])
    with a1:
        if st.button("Adicionar tarefa", use_container_width=True, disabled=(st.session_state.task_count >= 10)):
            st.session_state.task_count += 1
            st.rerun()
    with a2:
        st.caption(f"{st.session_state.task_count}/10")

    # Validação
    filled = [t for t in tasks_raw if t["title"] and t["description"]]
    can_run = bool(user_name.strip()) and (len(filled) >= 3)

    if not can_run:
        st.markdown("<div class='warn'>Falta nome e 3 tarefas completas.</div>", unsafe_allow_html=True)

    st.write("")
    run = st.button("Priorizar com IA", type="primary", use_container_width=True, disabled=not can_run)

    st.markdown("</div>", unsafe_allow_html=True)

# -----------------------------
# Rodar IA e renderizar resultado
# -----------------------------
if run and can_run:
    scroll_to_top()

    # Mensagem abaixo de Resultado enquanto processa
    status_ph.info("Priorizando a ordem...")

    payload = [
        {
            "title": t["title"],
            "description": t["description"],
            "user_chosen_help": t["help"],
            "user_chosen_time": t["time"],
            "help_label": t["help_label"],
            "time_label": t["time_label"],
            "note": "O modelo deve cruzar rótulos e descrição para estimar tempo e complexidade.",
        }
        for t in filled
    ]

    try:
        with st.spinner("Priorizando a ordem..."):
            result = call_openai_prioritize(user_name.strip(), method, payload)

        status_ph.empty()

        # Tabela simples antes do texto
        order_rows = [{"Ordem": item.position, "Tarefa": item.task_title} for item in result.ordered_tasks]
        table_ph.table(order_rows)

        # Texto completo depois
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
