"""
¿Qué tan bien funciona? Se compara lo que propuso el asistente con la
"verdad" que se conoce porque los datos son sintéticos (data/verdad*.csv).

La métrica que más importa no es acertar siempre, sino NO equivocarse con
confianza: una consulta marcada "Repetida" con el antecedente equivocado es
un mail mal respondido. Las dudosas van a revisión y las decide una persona.
"""

from __future__ import annotations

import pandas as pd


def evaluar(resultados: pd.DataFrame, verdad: pd.DataFrame, verdad_historial: pd.DataFrame) -> pd.DataFrame:
    """Una fila por consulta con lo propuesto, lo esperado y si coincide."""
    tema_hilo = verdad_historial.set_index("Hilo ID")["tema"]
    df = resultados.merge(verdad, left_on="mensaje_id", right_on="Mensaje ID", how="left")
    df["tema_antecedente"] = df["antecedente"].map(lambda a: tema_hilo.get(a["hilo"]) if isinstance(a, dict) else None)
    df["antecedente_correcto"] = df["tema_antecedente"] == df["tema"]
    df["desorden_detectado"] = df["tono"] == "Firme y pedagógico"

    def veredicto(f) -> str:
        if f["clasificacion"] == "Repetida":
            return "Acierto" if f["repetida"] and f["antecedente_correcto"] else "Error con confianza"
        if f["clasificacion"] == "Nueva":
            return "Acierto" if not f["repetida"] else "Repetida no detectada"
        # Posible antecedente: no afirma nada, lo decide una persona
        return "A revisión (antecedente útil)" if f["antecedente_correcto"] else "A revisión (sin antecedente útil)"

    df["veredicto"] = df.apply(veredicto, axis=1)
    return df[["mensaje_id", "persona", "asunto", "tema", "repetida", "desorden", "clasificacion",
               "similitud", "tema_antecedente", "antecedente_correcto", "desorden_detectado", "veredicto"]]


def resumen(evaluacion: pd.DataFrame) -> dict:
    e = evaluacion
    rep = e[e["repetida"]]
    marcadas = e[e["clasificacion"] == "Repetida"]
    return {
        "consultas": len(e),
        "repetidas_reales": int(rep["repetida"].sum()),
        "repetidas_con_antecedente_correcto": int((rep["clasificacion"] != "Nueva").mul(rep["antecedente_correcto"]).sum()),
        "marcadas_repetida": len(marcadas),
        "precision_repetida": float(marcadas["antecedente_correcto"].mean()) if len(marcadas) else float("nan"),
        "errores_con_confianza": int((e["veredicto"] == "Error con confianza").sum()),
        "desorden_reales": int(e["desorden"].sum()),
        "desorden_detectados": int((e["desorden"] & e["desorden_detectado"]).sum()),
        "falsas_alarmas_desorden": int((~e["desorden"] & e["desorden_detectado"]).sum()),
        "a_revision": int(e["clasificacion"].eq("Posible antecedente").sum()),
        "nuevas_bien_marcadas": int((~e["repetida"] & e["clasificacion"].ne("Repetida")).sum()),
        "nuevas_reales": int((~e["repetida"]).sum()),
    }
