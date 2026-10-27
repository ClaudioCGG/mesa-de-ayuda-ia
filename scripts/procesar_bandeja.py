"""
Procesa la bandeja de consultas nuevas y genera la bandeja de revisión.

    python scripts/procesar_bandeja.py                 # datos de ejemplo de data/
    python scripts/procesar_bandeja.py --datos otra/   # otra carpeta con historial.csv y bandeja.csv
    python scripts/procesar_bandeja.py --sin-ia        # fuerza borradores por plantilla
    python scripts/procesar_bandeja.py --sin-ia --publicar   # además actualiza docs/index.html

Si existe la variable GEMINI_API_KEY, los borradores de consultas repetidas
los redacta Gemini; si no, se arman por plantilla (sin costo ni internet).
"""

import argparse
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ / "src"))

from mesa_ayuda.historial import cargar_mensajes, exportar_expedientes  # noqa: E402
from mesa_ayuda.pipeline import correr  # noqa: E402
from mesa_ayuda.salidas import exportar_excel, exportar_html  # noqa: E402


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--datos", default=RAIZ / "data", type=Path)
    p.add_argument("--salida", default=RAIZ / "salida", type=Path)
    p.add_argument("--sin-ia", action="store_true")
    p.add_argument("--publicar", action="store_true", help="actualiza docs/index.html (GitHub Pages)")
    a = p.parse_args()

    s = correr(a.datos, preferir_ia=not a.sin_ia)
    a.salida.mkdir(exist_ok=True)
    exportar_excel(s["resultados"], a.salida / "bandeja_revision.xlsx", s.get("evaluacion"))
    exportar_html(s["resultados"], a.salida / "bandeja_revision.html", s.get("resumen"))
    if a.publicar:
        exportar_html(s["resultados"], RAIZ / "docs" / "index.html", s.get("resumen"))
    (a.salida / "expedientes.txt").write_text(exportar_expedientes(cargar_mensajes(a.datos / "historial.csv")),
                                              encoding="utf-8")

    print(f"Historial: {len(s['casos'])} casos respondidos · Bandeja: {len(s['resultados'])} consultas · "
          f"Redactor: {s['redactor']}")
    print(s["resultados"]["clasificacion"].value_counts().to_string())
    if "resumen" in s:
        r = s["resumen"]
        print(f"\nRepetidas con antecedente correcto: {r['repetidas_con_antecedente_correcto']}/{r['repetidas_reales']} · "
              f"errores con confianza: {r['errores_con_confianza']} · "
              f"desorden detectado: {r['desorden_detectados']}/{r['desorden_reales']} · a revisión: {r['a_revision']}")
    print(f"\nBandeja de revisión en {a.salida}/")


if __name__ == "__main__":
    main()
