"""
Lectura del historial de mails (el mismo formato que genera el Apps Script)
y armado de la "memoria" del estudio: un caso por hilo, con la pregunta del
cliente y la respuesta que se le dio.
"""

from __future__ import annotations

import re
from pathlib import Path

import pandas as pd

RECIBIDO, ENVIADO = "Recibido (Cliente)", "Enviado (Nosotros)"


def cargar_mensajes(ruta: str | Path) -> pd.DataFrame:
    df = pd.read_csv(ruta, parse_dates=["Fecha"])
    df["persona"] = df["Remitente"].str.split("@").str[0]
    return df.sort_values(["Hilo ID", "Fecha"]).reset_index(drop=True)


def _limpiar_respuesta(texto: str) -> str:
    """Saca el saludo y la firma para quedarse con el contenido de la respuesta."""
    t = re.sub(r"^\s*(hola|buen d[ií]a|buenas)[,!.\s]*", "", str(texto), flags=re.I)
    return re.split(r"\s+Saludos,", t)[0].strip()


def construir_casos(mensajes: pd.DataFrame) -> pd.DataFrame:
    """Un caso por hilo respondido: lo que preguntó el cliente antes de la
    primera respuesta del estudio, y esa respuesta."""
    casos = []
    for hilo, g in mensajes.groupby("Hilo ID", sort=False):
        respuestas = g[g["Dirección"] == ENVIADO]
        if respuestas.empty:
            continue
        primera = respuestas.iloc[0]
        previos = g[(g["Dirección"] == RECIBIDO) & (g["Fecha"] <= primera["Fecha"])]
        if previos.empty:
            continue
        casos.append({
            "hilo": hilo,
            "fecha": previos["Fecha"].iloc[0],
            "persona": previos["persona"].iloc[0],
            "asunto": previos["Asunto"].iloc[0],
            "pregunta": " ".join(previos["Resumen / Mensaje"].astype(str)),
            "fecha_respuesta": primera["Fecha"],
            "respondio": primera["persona"],
            "respuesta": _limpiar_respuesta(primera["Resumen / Mensaje"]),
            "respuesta_con_adjunto": bool(primera["Tiene Adjuntos"]),
            "screenshot": bool(previos["Posible Screenshot (sin PDF)"].any()),
        })
    return pd.DataFrame(casos)


def exportar_expedientes(mensajes: pd.DataFrame, nombre_cliente: str = "Cliente Ejemplo") -> str:
    """Misma salida que exportarExpedientes() del Apps Script: el TXT que lee NotebookLM."""
    partes = [f"=== EXPEDIENTES DE MAILS — {nombre_cliente} ===",
              f"Total de hilos: {mensajes['Hilo ID'].nunique()}", ""]
    for n, (hilo, g) in enumerate(mensajes.groupby("Hilo ID", sort=False), 1):
        partes += ["─" * 41, f"HILO #{n} — {g['Asunto'].iloc[0]}", f"ID: {hilo}",
                   f"Cantidad de mensajes: {len(g)}", "─" * 41]
        for i, m in enumerate(g.itertuples(index=False), 1):
            adj = m[9] if m[8] else "ninguno"
            alerta = "  ⚠ POSIBLE SCREENSHOT SIN PDF ADJUNTO" if m[10] else ""
            partes += ["", f"[Mensaje {i}] {m[3]} — {m[0]:%d/%m/%Y %H:%M}", f"De: {m[4]}",
                       f"Adjuntos: {adj}{alerta}", f"Texto: {m[7]}"]
        partes.append("")
    return "\n".join(partes)
