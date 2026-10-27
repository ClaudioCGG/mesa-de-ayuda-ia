"""Corrida completa: historial → casos → bandeja analizada → métricas."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from .asistente import Asistente, crear_redactor
from .historial import cargar_mensajes, construir_casos
from .metricas import evaluar, resumen

RAIZ = Path(__file__).resolve().parents[2]


def correr(datos: str | Path = RAIZ / "data", preferir_ia: bool = True) -> dict:
    datos = Path(datos)
    casos = construir_casos(cargar_mensajes(datos / "historial.csv"))
    bandeja = pd.read_csv(datos / "bandeja.csv", parse_dates=["Fecha"])
    asistente = Asistente(casos, crear_redactor(preferir_ia))
    resultados = asistente.procesar_bandeja(bandeja)

    salida = {"casos": casos, "bandeja": bandeja, "resultados": resultados,
              "redactor": asistente.redactor.nombre}
    if (datos / "verdad.csv").exists():
        ev = evaluar(resultados, pd.read_csv(datos / "verdad.csv"), pd.read_csv(datos / "verdad_historial.csv"))
        salida |= {"evaluacion": ev, "resumen": resumen(ev)}
    return salida
