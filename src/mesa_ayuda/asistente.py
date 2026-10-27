"""
El asistente: para cada consulta nueva busca antecedentes, la clasifica,
elige el tono y redacta un borrador. Nada se envía solo: todo queda en una
bandeja para que una persona lo lea, lo corrija y lo apruebe.

Clasificación (de más segura a menos):
    Repetida             el antecedente es claro (similitud alta): se cita y se reutiliza la respuesta.
    Posible antecedente  hay algo parecido pero no alcanza: se muestra para que decida una persona.
    Nueva                no hay antecedente: acuse de recibo y derivación al equipo, sin inventar.

Desorden operativo (cambia el tono a "firme y pedagógico"):
    - el cliente mandó una captura de pantalla en lugar del comprobante en PDF, o
    - la MISMA persona ya hizo esa consulta y se le respondió.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

import pandas as pd

from .buscador import BuscadorAntecedentes, normalizar

UMBRAL_REPETIDA = 0.45     # similitud del mejor antecedente para afirmar que es repetida
UMBRAL_POSIBLE = 0.30      # por debajo de esto, consulta nueva
VECINOS = 5                # antecedentes que se miran para decidir el tema
DIAS_REPREGUNTA = 365      # ventana para considerar que la misma persona ya preguntó lo mismo

MESES = r"enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre"


def clave_respuesta(texto: str) -> str:
    """Agrupa respuestas equivalentes (misma respuesta con otro mes o año)."""
    return re.sub(rf"\d+|{MESES}", "", normalizar(texto))[:80]


@dataclass
class Resultado:
    mensaje_id: str
    fecha: pd.Timestamp
    persona: str
    asunto: str
    consulta: str
    clasificacion: str
    tono: str
    similitud: float
    antecedente: dict | None
    alertas: list[str] = field(default_factory=list)
    borrador: str = ""
    estado: str = "Pendiente de revisión"


class Asistente:
    def __init__(self, casos: pd.DataFrame, redactor=None):
        self.casos = casos.assign(clave=casos["respuesta"].map(clave_respuesta))
        self.buscador = BuscadorAntecedentes(self.casos)
        self.redactor = redactor or crear_redactor()

    # ------------------------------------------------------------------
    def _mejor_grupo(self, candidatos: pd.DataFrame) -> tuple[pd.DataFrame, float]:
        """Entre los vecinos más parecidos, el grupo de casos con la misma respuesta
        que suma más similitud. Devuelve los casos del grupo y su mejor similitud."""
        cand = candidatos.assign(clave=candidatos["respuesta"].map(clave_respuesta))
        puntajes = cand.groupby("clave")["similitud"].sum().sort_values(ascending=False)
        clave = puntajes.index[0]
        grupo = cand[cand["clave"] == clave].sort_values("similitud", ascending=False)
        return grupo, float(grupo["similitud"].max())

    def analizar(self, consulta: pd.Series) -> Resultado:
        texto = f"{consulta['Asunto']} {consulta['Resumen / Mensaje']}"
        persona = str(consulta["Remitente"]).split("@")[0]
        fecha = pd.Timestamp(consulta["Fecha"])
        grupo, sim = self._mejor_grupo(self.buscador.buscar(texto, VECINOS))

        if sim >= UMBRAL_REPETIDA:
            clasificacion = "Repetida"
        elif sim >= UMBRAL_POSIBLE:
            clasificacion = "Posible antecedente"
        else:
            clasificacion = "Nueva"

        antecedente = grupo.iloc[0].to_dict() if clasificacion != "Nueva" else None
        alertas = []
        if bool(consulta.get("Posible Screenshot (sin PDF)", False)):
            alertas.append("Mandó una captura de pantalla en lugar del comprobante en PDF.")
        if clasificacion == "Repetida":
            # ¿La misma persona ya preguntó esto? Se busca en TODO el historial del grupo
            mismos = self.casos[(self.casos["clave"] == grupo["clave"].iloc[0]) & (self.casos["persona"] == persona)
                                & (self.casos["fecha"] >= fecha - pd.Timedelta(days=DIAS_REPREGUNTA))]
            if not mismos.empty:
                ult = mismos.sort_values("fecha").iloc[-1]
                antecedente = ult.to_dict() | {"similitud": antecedente["similitud"]}
                alertas.append(f"La misma persona ya hizo esta consulta el {ult['fecha']:%d/%m/%Y}.")
            veces = int((self.casos["clave"] == grupo["clave"].iloc[0]).sum())
            alertas.append(f"Consulta respondida {veces} veces en el último año.")

        desorden = any(a.startswith(("Mandó una captura", "La misma persona")) for a in alertas)
        tono = ("Firme y pedagógico" if desorden else
                "Cordial con antecedente" if clasificacion == "Repetida" else
                "A definir por quien revisa" if clasificacion == "Posible antecedente" else "Cordial")

        r = Resultado(consulta["Mensaje ID"], fecha, persona, consulta["Asunto"], consulta["Resumen / Mensaje"],
                      clasificacion, tono, sim, antecedente, alertas)
        r.borrador = self.redactor.redactar(r)
        return r

    def procesar_bandeja(self, bandeja: pd.DataFrame) -> pd.DataFrame:
        filas = [vars(self.analizar(c)) for _, c in bandeja.iterrows()]
        return pd.DataFrame(filas)


# ----------------------------------------------------------------------
# Redacción del borrador
# ----------------------------------------------------------------------
def _nombre(persona: str) -> str:
    base = persona.split(".")[0]
    return "" if base in ("admin", "compras", "info") else base.capitalize()


def respuesta_reutilizable(texto: str) -> str:
    """Saca de la respuesta anterior las frases atadas a aquel caso puntual
    (las que nombran un mes, como "les reenviamos la de junio")."""
    frases = re.split(r"(?<=[.!?])\s+", texto)
    return " ".join(f for f in frases if not re.search(MESES, f, flags=re.I)).strip() or texto


class RedactorPlantillas:
    """Arma el borrador reutilizando la respuesta ya dada. Sin costo ni API key."""

    nombre = "plantillas"
    FIRMA = "Saludos,\nEquipo de Facturación"

    def redactar(self, r: Resultado) -> str:
        saludo = f"Hola{', ' + _nombre(r.persona) if _nombre(r.persona) else ''}:"
        a = r.antecedente
        respuesta = respuesta_reutilizable(a["respuesta"]) if a else ""
        adjunto = ("\n\n[ADJUNTAR: el comprobante solicitado, como en el antecedente]"
                   if a and a.get("respuesta_con_adjunto") else "")
        if r.clasificacion == "Nueva":
            cuerpo = ("Recibimos tu consulta. La estamos revisando con el equipo y te respondemos dentro de las "
                      "próximas 48 horas hábiles.")
        elif r.clasificacion == "Posible antecedente":
            cuerpo = (f"[PARA REVISAR: posible relación con la consulta del {a['fecha']:%d/%m/%Y} "
                      f"(\"{a['asunto']}\"). Si aplica, se puede reutilizar esta respuesta:]\n\n{respuesta}{adjunto}")
        elif r.tono == "Firme y pedagógico":
            if any(x.startswith("Mandó una captura") for x in r.alertas):
                intro = ("Gracias por enviarlo. Para poder registrarlo necesitamos la documentación completa; "
                         "te recordamos cómo es el procedimiento:")
            else:
                intro = (f"Esta consulta ya la respondimos el {a['fecha_respuesta']:%d/%m/%Y}. "
                         "Te la dejamos nuevamente para que quede a mano:")
            cuerpo = (f"{intro}\n\n{respuesta}{adjunto}\n\nPara agilizar las próximas gestiones, te sugerimos "
                      "guardar este mail o compartirlo con el resto del equipo de administración.")
        else:
            cuerpo = (f"Es una consulta que ya respondimos anteriormente "
                      f"(el {a['fecha_respuesta']:%d/%m/%Y}). Te compartimos la respuesta:\n\n{respuesta}{adjunto}")
        return f"{saludo}\n\n{cuerpo}\n\n{self.FIRMA}"


class RedactorGemini(RedactorPlantillas):
    """Mismo flujo, pero el texto lo redacta un LLM a partir del antecedente.
    Requiere GEMINI_API_KEY y el paquete google-genai."""

    nombre = "gemini"

    def __init__(self, modelo: str | None = None):
        from google import genai  # import diferido

        self.cliente = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
        self.modelo = modelo or os.environ.get("GEMINI_MODEL", "gemini-3.6-flash")
        self.plantilla = (Path(__file__).resolve().parents[2] / "prompts" / "redactor.md").read_text(encoding="utf-8")

    def redactar(self, r: Resultado) -> str:
        if r.clasificacion != "Repetida":
            return super().redactar(r)  # sin antecedente claro, no se le pide al modelo que invente
        a = r.antecedente
        prompt = self.plantilla.format(
            consulta=r.consulta, persona=_nombre(r.persona) or "equipo", tono=r.tono,
            alertas="\n".join(f"- {x}" for x in r.alertas) or "- ninguna",
            fecha_antecedente=f"{a['fecha_respuesta']:%d/%m/%Y}", respuesta_antecedente=respuesta_reutilizable(a["respuesta"]))
        try:
            resp = self.cliente.models.generate_content(model=self.modelo, contents=prompt,
                                                        config={"temperature": 0.2})
            return resp.text.strip()
        except Exception:  # noqa: BLE001 - si la IA falla, queda el borrador por plantilla
            return super().redactar(r)


def crear_redactor(preferir_ia: bool = True):
    if preferir_ia and os.environ.get("GEMINI_API_KEY"):
        try:
            return RedactorGemini()
        except ImportError:
            pass
    return RedactorPlantillas()
