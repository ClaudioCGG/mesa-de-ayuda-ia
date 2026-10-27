# Mesa de Ayuda IA

**Asistente para responder consultas de clientes que ya se respondieron antes: busca el antecedente, propone un borrador y una persona lo aprueba.**

🔗 **[Ver la bandeja de revisión](https://claudiocgg.github.io/mesa-de-ayuda-ia/)** · [Cuaderno paso a paso](notebooks/demo_mesa_de_ayuda.ipynb) · [Apps Script](apps_script/) · [Borradores en Gmail](#borradores-directamente-en-gmail)

> Todos los nombres, mails y conversaciones de este repositorio son ficticios, generados aleatoriamente para demostración; cualquier coincidencia con personas o empresas reales es casual. Es una recreación de una herramienta que uso en un estudio contable.

---

## El problema

Un estudio contable atiende la facturación de un cliente con varias personas en administración. Las mismas consultas llegan una y otra vez: *"¿me reenvían la factura?"*, *"salió con el CUIT mal"*, *"¿cuándo vence el IVA?"*. A veces las hace alguien nuevo; a veces, la misma persona que ya preguntó hace dos meses. Y cada tanto llega una captura de pantalla de una transferencia en lugar del comprobante en PDF.

Responder cada mail desde cero lleva tiempo, y las respuestas salen distintas según quién conteste.

## Qué hace

| Paso | Herramienta | Resultado |
|---|---|---|
| 1. Juntar el historial | Google Apps Script | Los mails con el cliente pasan a una Google Sheet, sin duplicar, con un disparador diario. Marca los mensajes con captura y sin PDF. |
| 2. Armar la memoria | Apps Script / Python | Un TXT de "expedientes", un bloque por hilo, con lo que preguntó el cliente y lo que se le respondió. |
| 3. Analizar cada consulta nueva | Python (o NotebookLM) | Busca antecedentes, clasifica, detecta desorden operativo y elige el tono. |
| 4. Borrador en Gmail | Apps Script + Gemini | La respuesta propuesta queda como borrador dentro de la misma conversación, con la etiqueta "Revisar IA". |
| 5. Revisión humana | Gmail + hoja "Bandeja IA" | Cada borrador se lee, se corrige y se envía. **Nada se envía solo.** |

### Clasificación

| | Cuándo | Qué propone |
|---|---|---|
| **Repetida** | antecedente claro (similitud ≥ 0,45) | cita la fecha de la respuesta anterior y la reutiliza |
| **Posible antecedente** | algo parecido (0,30 – 0,45) | lo muestra marcado `[PARA REVISAR]`: decide una persona |
| **Nueva** | sin antecedente | acuse de recibo y derivación, sin inventar una respuesta |

### Desorden operativo → tono "firme y pedagógico"

- el cliente mandó una **captura de pantalla** en lugar del comprobante en PDF, o
- **la misma persona** ya hizo esa consulta y se le respondió.

El borrador recuerda el procedimiento y sugiere guardar el mail para la próxima vez. Respetuoso, nunca irónico.

## Resultados sobre la bandeja de prueba

11 consultas de una semana contra un historial de 64 conversaciones:

| Métrica | Resultado |
|---|---|
| Consultas repetidas encontradas con el antecedente correcto | **8 de 8** |
| Errores con confianza ("Repetida" con el antecedente equivocado) | **0** |
| Desorden operativo detectado | **2 de 2**, sin falsas alarmas |
| Enviadas a revisión por dudosas | 2 |
| Consultas nuevas respondidas "de fondo" por error | 0 |

La métrica que más importa es la segunda: **un asistente que se equivoca con confianza es peor que no tener asistente.** Por eso hay una zona intermedia ("Posible antecedente") donde la decisión es de una persona.

En el uso real, preparar la respuesta a una consulta repetida pasó de buscar el mail viejo, copiarlo y adaptarlo a revisar un borrador que ya trae el antecedente citado.

## Borradores directamente en Gmail

[`Borradores.gs`](apps_script/Borradores.gs) cierra el circuito sin salir de Google. Cada hora:

1. Busca las conversaciones con el cliente cuyo último mensaje es del cliente (todavía sin respuesta) y que no tienen ya un borrador.
2. Le pasa a Gemini la consulta y los expedientes, y le pide una respuesta estructurada (JSON): clasificación, hilo del antecedente, tono, borrador y qué revisar.
3. **Controla en código lo que se puede verificar**, en lugar de creerle al modelo:
   - si el antecedente citado no existe en el historial, la consulta baja a "Posible antecedente" y queda una alerta;
   - la fecha del antecedente sale de la hoja, no del modelo;
   - la captura sin PDF y "la misma persona ya preguntó" se detectan en código y fijan el tono;
   - si es una consulta nueva, el borrador es un acuse de recibo fijo: el modelo no responde de fondo.
4. Deja el borrador **dentro de la conversación de Gmail** con la etiqueta "Revisar IA" y lo anota en la pestaña "Bandeja IA" con un link para abrirlo.
5. En las corridas siguientes se fija si la respuesta ya salió y **cuánto se parece al borrador**: "Enviado sin cambios" o "Editado y enviado", con las horas hasta responder. Eso es la métrica de uso real.

Si una llamada falla, esa consulta queda marcada "Responder a mano" y el resto sigue. Corriendo dos veces seguidas no duplica nada.

**Privacidad.** Antes de enviar el texto al modelo se tapan CUIT, CBU/CVU, números de tarjeta y direcciones de mail (`ANONIMIZAR`). En el nivel gratuito de la API de Gemini, Google puede usar lo que se le envía para mejorar sus productos; para mails reales de clientes conviene el nivel pago (con este volumen cuesta centavos por mes) o Gemini dentro de Google Workspace.

**Instalación:** en la misma Google Sheet, agregar `Borradores.gs` al proyecto de Apps Script → menú *Mesa de Ayuda* → *Guardar API key de Gemini* (se crea en [Google AI Studio](https://aistudio.google.com/)) → *Preparar borradores en Gmail* para probar → *Programar borradores cada hora*. El nombre del modelo está en `IA.MODELO`; conviene confirmar el vigente en la [lista de modelos](https://ai.google.dev/gemini-api/docs/models).

**Pruebas:** [`apps_script/pruebas/simulador.test.js`](apps_script/pruebas/simulador.test.js) simula Gmail, Sheets y la API de Gemini y corre el flujo completo, incluidos un antecedente inventado por el modelo, un error de la API, datos sensibles y la medición de lo enviado (`node apps_script/pruebas/simulador.test.js`).

> Gmail busca palabras completas: "factura" no encuentra "facturamos". Conviene que `PALABRAS_CLAVE` incluya las variantes que usa el cliente.

## Versión en producción y versión de este repositorio

| | En el estudio | En este repositorio |
|---|---|---|
| Historial | Gmail → Google Sheet con Apps Script | el mismo script, generalizado ([`Codigo.gs`](apps_script/Codigo.gs)), y datos sintéticos con el mismo formato |
| Búsqueda de antecedentes | NotebookLM sobre el TXT de expedientes | Python: TF-IDF + similitud coseno, reproducible y medible |
| Redacción | NotebookLM con instrucciones ([`prompts/notebooklm.md`](prompts/notebooklm.md)) | plantillas, u opcionalmente Gemini ([`prompts/redactor.md`](prompts/redactor.md)) |
| Revisión | una persona antes de enviar | borrador en Gmail ([`Borradores.gs`](apps_script/Borradores.gs)), bandeja en Excel y [página](https://claudiocgg.github.io/mesa-de-ayuda-ia/) |

La versión en Python existe para poder **medir**: con datos donde se conoce la respuesta correcta, se puede probar cada cambio de umbral o de redacción y ver si mejora o empeora.

## Cómo usarlo

```bash
pip install -r requirements.txt
python scripts/procesar_bandeja.py --sin-ia     # bandeja de revisión en salida/
python -m pytest                                 # 17 pruebas (incluye la del Apps Script si hay Node)
```

Para que los borradores de consultas repetidas los redacte Gemini:

```bash
pip install google-genai
export GEMINI_API_KEY=...        # gratuita en Google AI Studio
python scripts/procesar_bandeja.py
```

Si la API falla o no hay clave, los borradores se arman por plantilla. A las consultas sin antecedente claro nunca se les pide al modelo que redacte: no tiene de dónde sacar la respuesta.

Para usarlo con mails propios: correr el Apps Script en una Google Sheet, descargarla como `historial.csv` y poner las consultas nuevas en `bandeja.csv` con las mismas columnas.

## Estructura

```
apps_script/Codigo.gs        Gmail → Sheet → TXT de expedientes, con disparador diario
apps_script/Borradores.gs    Gemini → borrador en el hilo de Gmail + pestaña "Bandeja IA"
apps_script/pruebas/         simulación de Gmail, Sheets y Gemini para probar el script
src/mesa_ayuda/
  historial.py               un caso por hilo: pregunta del cliente + respuesta del estudio
  buscador.py                búsqueda de antecedentes (TF-IDF con n-gramas de caracteres)
  asistente.py               clasificación, alertas, tono y redacción del borrador
  metricas.py                comparación contra la respuesta correcta
  salidas.py                 bandeja de revisión en Excel y HTML
prompts/                     instrucciones para NotebookLM y para Gemini
scripts/                     generador de datos y procesamiento de la bandeja
notebooks/                   demo paso a paso (se puede abrir en Colab)
ejemplos/                    TXT de expedientes y bandeja en Excel de ejemplo
docs/                        página publicada en GitHub Pages
```

## Decisiones de diseño

- **Humano en el circuito.** Todo borrador sale como "Pendiente de revisión". El asistente ahorra la búsqueda y la redacción, no la responsabilidad.
- **Agrupar respuestas equivalentes.** Una misma consulta se respondió muchas veces cambiando solo el mes. El asistente agrupa esas respuestas y suma la similitud del grupo, en lugar de quedarse con el mail más parecido.
- **No reciclar lo puntual.** De la respuesta anterior se sacan las frases atadas a aquel caso ("les reenviamos la de junio") y, si iba con adjunto, se deja la marca `[ADJUNTAR]`.
- **Sin dependencia de una API.** La versión en Python funciona sin internet ni costo; el LLM es una mejora opcional, no un requisito.
- **No creerle al modelo lo verificable.** Lo que se puede comprobar contra los datos (que el antecedente exista, su fecha, quién preguntó) se comprueba en código.
- **Medir con el uso real.** El porcentaje de borradores enviados sin cambios dice más que cualquier prueba con datos de ejemplo.

---

Claudio Gabriel Guirado · Procesos y automatización con IA para administración y finanzas · [GitHub](https://github.com/ClaudioCGG)
