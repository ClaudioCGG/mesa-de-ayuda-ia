"""
Genera un historial de mails SINTÉTICO entre un estudio contable y un cliente,
con el mismo formato de columnas que produce el Apps Script (apps_script/Codigo.gs).

- data/historial.csv  : 12 meses de hilos ya respondidos (la "memoria" del estudio)
- data/bandeja.csv    : consultas nuevas del cliente, todavía sin responder
- data/verdad.csv     : para cada consulta nueva, el tema real y si es repetida o
                        muestra desorden operativo (para medir al asistente)

El cliente tiene varios administrativos que rotan: por eso las mismas preguntas
vuelven una y otra vez, escritas de formas distintas.
Todos los nombres, dominios y datos son inventados.
"""

from __future__ import annotations

import random
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd

SEMILLA = 11
RAIZ = Path(__file__).resolve().parents[1]
random.seed(SEMILLA)

DOM_CLIENTE = "@cliente-ejemplo.com"
DOM_ESTUDIO = "@estudio-ejemplo.com.ar"
CONTACTOS_CLIENTE = ["mariela.paz", "jonatan.ruiz", "carla.benitez", "admin", "lucas.ferro"]
CONTACTOS_NUEVOS = ["romina.diaz", "tomas.quiroga"]   # personal que el cliente incorporó hace poco
CONTACTOS_ESTUDIO = ["facturacion", "nicolas.vera"]
FIRMA_ESTUDIO = "Saludos,\nEquipo de Facturación\nEstudio Contable Ejemplo"
MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
         "septiembre", "octubre", "noviembre", "diciembre"]

# ----------------------------------------------------------------------
# Temas: varias formas de preguntar lo mismo + la respuesta del estudio
# ----------------------------------------------------------------------
TEMAS = {
    "reenvio_factura": {
        "asunto": ["Factura de {mes}", "Reenvío factura", "No encuentro la factura", "Factura {mes} - urgente"],
        "preguntas": [
            "Hola, ¿me pueden reenviar la factura de {mes}? No la encuentro en el mail.",
            "Buenas, necesito la factura del mes de {mes}, ¿la pueden mandar de nuevo?",
            "¿Me reenvían por favor la factura correspondiente a {mes}? Se me traspapeló.",
            "Hola, no me llegó la factura de {mes}. ¿Me la envían?",
        ],
        "nuevas": ["Disculpen, ¿alguien me puede pasar otra vez la factura de {mes}? No la tengo.",
                   "Buen día, ¿dónde puedo encontrar la factura de {mes}? Necesito descargarla."],
        "respuesta": ("Las facturas se envían el día 5 de cada mes a la casilla de compras de ustedes y además "
                      "quedan guardadas en la carpeta compartida de Drive \"Facturas {anio}\", ordenadas por mes. "
                      "Les reenviamos la de {mes} adjunta."),
    },
    "cuit_erroneo": {
        "asunto": ["Factura con datos mal", "Error en CUIT de la factura", "Corregir factura"],
        "preguntas": [
            "La factura salió con el CUIT equivocado, ¿cómo la corregimos?",
            "Hola, la última factura tiene mal la razón social. ¿Se puede modificar?",
            "Detectamos que la factura tiene un error en el CUIT del cliente. ¿Qué hacemos?",
        ],
        "nuevas": ["Nos emitieron una factura con la razón social incorrecta, ¿se puede cambiar o hay que anularla?"],
        "respuesta": ("Una factura electrónica no se puede modificar una vez emitida. El procedimiento es emitir una "
                      "nota de crédito que anule la factura original y luego una factura nueva con los datos correctos. "
                      "Para hacerlo necesitamos el número de la factura y los datos correctos del cliente."),
    },
    "vencimiento_iva": {
        "asunto": ["Vencimiento IVA", "Consulta vencimientos", "¿Cuándo se paga el IVA?"],
        "preguntas": [
            "¿Cuándo vence el IVA de {mes}?",
            "Hola, ¿me confirman la fecha de vencimiento del IVA de este mes?",
            "Necesito saber hasta cuándo tenemos para pagar el IVA de {mes}.",
        ],
        "nuevas": ["Buenas, ¿qué día vence la declaración de IVA de {mes}? Queremos tener los fondos."],
        "respuesta": ("El IVA vence según la terminación del CUIT: para ustedes (terminación 7) vence el día 22 del "
                      "mes siguiente. Además, el calendario completo del año está en la carpeta compartida "
                      "\"Vencimientos {anio}\" y les enviamos un recordatorio 5 días antes de cada vencimiento."),
    },
    "comprobante_pago": {
        "asunto": ["Pago proveedor", "Les paso el pago", "Comprobante de pago"],
        "preguntas": [
            "Les mando la captura de la transferencia al proveedor para que la registren.",
            "Adjunto foto del pago que hicimos ayer.",
            "Hola, les paso el pantallazo del pago a Transportes del Sur.",
        ],
        "nuevas": ["Ahí les mando la captura de pantalla de la transferencia que hicimos hoy."],
        "respuesta": ("Para registrar el pago necesitamos el comprobante en PDF que emite el banco (no una captura de "
                      "pantalla) y la factura del proveedor. Con la captura no podemos verificar el número de "
                      "operación ni la cuenta de destino."),
        "screenshot": True,
    },
    "nota_credito_devolucion": {
        "asunto": ["Devolución de mercadería", "Nota de crédito", "Pedido de NC"],
        "preguntas": [
            "Un cliente nos devolvió mercadería, ¿cómo hacemos la nota de crédito?",
            "Necesitamos emitir una nota de crédito por una devolución. ¿Qué datos les pasamos?",
        ],
        "nuevas": ["Tuvimos una devolución parcial de un pedido, ¿cómo se refleja en la facturación?"],
        "respuesta": ("Para emitir la nota de crédito por devolución necesitamos: número de la factura original, "
                      "detalle de los productos devueltos con cantidades e importes, y el remito de devolución "
                      "firmado. Con eso la emitimos en el día."),
    },
    "factura_exterior": {
        "asunto": ["Venta al exterior", "Factura para cliente de Uruguay", "Exportación"],
        "preguntas": [
            "Tenemos un cliente en Uruguay, ¿qué factura le tenemos que hacer?",
            "¿Cómo facturamos una venta a un cliente del exterior?",
        ],
        "nuevas": ["Nos contactó una empresa de Chile para comprarnos, ¿cómo se le factura?"],
        "respuesta": ("A clientes del exterior se les emite factura E (exportación). Necesitamos los datos fiscales "
                      "del cliente en su país, la condición de venta (FOB, CIF, etc.) y la moneda. Si es mercadería, "
                      "además hace falta el permiso de embarque del despachante."),
    },
    "tipo_factura": {
        "asunto": ["Factura A o B", "Consulta tipo de factura"],
        "preguntas": [
            "¿A un monotributista le hacemos factura A o B?",
            "Un cliente nuevo es monotributista, ¿qué tipo de factura le corresponde?",
        ],
        "nuevas": ["Si el cliente es consumidor final, ¿se le hace factura B? ¿Y si es monotributista?"],
        "respuesta": ("Ustedes son responsables inscriptos: a otro responsable inscripto le corresponde factura A; "
                      "a monotributistas, exentos y consumidores finales, factura B."),
    },
}

# Consultas sobre temas que no están en el historial (el asistente no debe inventar un antecedente)
NUEVOS_TEMAS = [
    ("anticipo", "Facturar un anticipo", "Un cliente nos va a pagar un anticipo del 30% antes de la entrega, ¿cómo lo facturamos?"),
    ("certificado_ganancias", "Certificado de retención", "Nos pidieron el certificado de retención de ganancias de agosto, ¿quién lo emite?"),
    ("domicilio_fiscal", "Cambio de domicilio", "Nos mudamos el mes que viene, ¿qué hay que hacer con el domicilio fiscal?"),
]

filas_hist: list[list] = []
temas_hilo: list[dict] = []
_id = iter(range(100_000, 999_999))


def mensaje(fecha, hilo, direccion, de, para, asunto, texto, adjuntos=""):
    tipos = adjuntos
    tiene = bool(adjuntos)
    screenshot = ("image/" in adjuntos) and ("pdf" not in adjuntos)
    return [fecha, hilo, f"m{next(_id)}", direccion, de, para, asunto, texto.replace("\n", " "), tiene, tipos, screenshot]


def email(usuario, dominio):
    return f"{usuario}{dominio}"


# ----------------------------------------------------------------------
# Historial: 12 meses de consultas respondidas
# ----------------------------------------------------------------------
inicio = datetime(2025, 10, 1, 9, 0)
temas = list(TEMAS)
for n in range(64):
    tema = temas[n % len(temas)] if n < 28 else random.choice(temas)
    t = TEMAS[tema]
    fecha = inicio + timedelta(days=random.randint(0, 360), hours=random.randint(0, 8), minutes=random.randint(0, 59))
    mes = MESES[(fecha.month - 2) % 12]
    hilo = f"h{n + 1:04d}"
    temas_hilo.append({"Hilo ID": hilo, "tema": tema})
    persona = random.choice(CONTACTOS_CLIENTE)
    asunto = random.choice(t["asunto"]).format(mes=mes)
    pregunta = random.choice(t["preguntas"]).format(mes=mes)
    adj = "image/jpeg" if t.get("screenshot") else ""
    filas_hist.append(mensaje(fecha, hilo, "Recibido (Cliente)", email(persona, DOM_CLIENTE),
                              email(random.choice(CONTACTOS_ESTUDIO), DOM_ESTUDIO), asunto,
                              f"{pregunta} Gracias, {persona.split('.')[0].capitalize()}", adj))
    resp = t["respuesta"].format(mes=mes, anio=fecha.year)
    f_resp = fecha + timedelta(hours=random.randint(2, 30))
    if not 9 <= f_resp.hour < 19:  # el estudio responde en horario de oficina
        f_resp = (f_resp + timedelta(days=f_resp.hour >= 19)).replace(hour=10, minute=random.randint(0, 59))
    filas_hist.append(mensaje(f_resp, hilo, "Enviado (Nosotros)", email(random.choice(CONTACTOS_ESTUDIO), DOM_ESTUDIO),
                              email(persona, DOM_CLIENTE), "RE: " + asunto, f"Hola, {resp} {FIRMA_ESTUDIO}",
                              "application/pdf" if tema == "reenvio_factura" else ""))
    if random.random() < 0.4:
        filas_hist.append(mensaje(f_resp + timedelta(hours=3), hilo, "Recibido (Cliente)", email(persona, DOM_CLIENTE),
                                  email(random.choice(CONTACTOS_ESTUDIO), DOM_ESTUDIO), "RE: " + asunto,
                                  "Perfecto, muchas gracias."))

historial = pd.DataFrame(filas_hist, columns=[
    "Fecha", "Hilo ID", "Mensaje ID", "Dirección", "Remitente", "Destinatario", "Asunto",
    "Resumen / Mensaje", "Tiene Adjuntos", "Tipos de Adjuntos", "Posible Screenshot (sin PDF)"])
historial = historial[historial["Fecha"] < datetime(2026, 10, 20)].sort_values(["Hilo ID", "Fecha"])

# ----------------------------------------------------------------------
# Bandeja: consultas nuevas (semana del 20/10/2026)
# ----------------------------------------------------------------------
bandeja, verdad = [], []
f0 = datetime(2026, 10, 20, 9, 0)


def nueva(tema, texto, asunto, persona, repetida, desorden, motivo, adj=""):
    n = len(bandeja)  # tres consultas por día hábil, en horario de oficina
    fecha = f0 + timedelta(days=n // 3, hours=(0, 3, 7)[n % 3], minutes=random.randint(0, 59))
    hilo = f"n{len(bandeja) + 1:03d}"
    fila = mensaje(fecha, hilo, "Recibido (Cliente)", email(persona, DOM_CLIENTE),
                   email("facturacion", DOM_ESTUDIO), asunto, texto, adj)
    bandeja.append(fila)
    verdad.append({"Mensaje ID": fila[2], "tema": tema, "repetida": repetida, "desorden": desorden, "motivo": motivo})


# Repetidas escritas distinto que en el historial
for tema in ("reenvio_factura", "cuit_erroneo", "vencimiento_iva", "nota_credito_devolucion",
             "factura_exterior", "tipo_factura"):
    t = TEMAS[tema]
    texto = random.choice(t["nuevas"]).format(mes="septiembre")
    nueva(tema, texto, random.choice(t["asunto"]).format(mes="septiembre"), random.choice(CONTACTOS_NUEVOS),
          True, False, "repetida: ya se respondió a otras personas; quien pregunta es nuevo en el cliente")

# Desorden operativo: captura sin PDF
t = TEMAS["comprobante_pago"]
nueva("comprobante_pago", t["nuevas"][0], "Pago proveedor", "jonatan.ruiz", True, True,
      "desorden: captura en lugar de comprobante, ya se explicó varias veces", "image/png")

# Desorden operativo: la misma persona repregunta lo que se le respondió hace poco
ultima = historial[historial["Resumen / Mensaje"].str.contains("reenviar la factura|reenvían|no me llegó la factura|necesito la factura", case=False)
                   & (historial["Dirección"] == "Recibido (Cliente)")].sort_values("Fecha").iloc[-1]
persona = ultima["Remitente"].split("@")[0]
nueva("reenvio_factura", "Hola, otra vez yo. Necesito de nuevo la factura de septiembre, urgente por favor, no la encuentro.",
      "URGENTE factura septiembre", persona, True, True,
      "desorden: la misma persona ya lo consultó y la factura está en la carpeta compartida")

# Temas nuevos
for tema, asunto, texto in NUEVOS_TEMAS:
    nueva(tema, texto, asunto, random.choice(CONTACTOS_CLIENTE + CONTACTOS_NUEVOS), False, False,
          "consulta nueva, sin antecedente")

df_bandeja = pd.DataFrame(bandeja, columns=historial.columns)


def main():
    (RAIZ / "data").mkdir(exist_ok=True)
    historial.to_csv(RAIZ / "data" / "historial.csv", index=False)
    df_bandeja.to_csv(RAIZ / "data" / "bandeja.csv", index=False)
    pd.DataFrame(verdad).to_csv(RAIZ / "data" / "verdad.csv", index=False)
    pd.DataFrame(temas_hilo).to_csv(RAIZ / "data" / "verdad_historial.csv", index=False)
    print(f"Historial: {historial['Hilo ID'].nunique()} hilos, {len(historial)} mensajes")
    print(f"Bandeja:   {len(df_bandeja)} consultas nuevas")


if __name__ == "__main__":
    main()
