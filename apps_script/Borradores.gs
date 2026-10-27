/**
 * MESA DE AYUDA IA — Paso 2: borradores de respuesta directamente en Gmail
 *
 * Cada hora (o a demanda) busca consultas del cliente que todavía no se
 * respondieron y, para cada una:
 *   1. le pasa a Gemini la consulta y los expedientes (lo que ya se respondió),
 *   2. controla en código lo que devuelve el modelo (que el antecedente exista,
 *      la fecha real, si es la misma persona, si mandó una captura),
 *   3. deja un BORRADOR de respuesta dentro de la misma conversación de Gmail,
 *      con la etiqueta "Revisar IA",
 *   4. lo anota en la pestaña "Bandeja IA" con el antecedente y las alertas.
 *
 * Nada se envía solo: una persona abre el borrador, lo corrige y lo envía.
 * En las corridas siguientes, el script se fija si la respuesta ya salió y si
 * se envió igual al borrador o con cambios. Eso mide el uso real.
 *
 * Requiere Codigo.gs en el mismo proyecto y una API key de Gemini
 * (menú Mesa de Ayuda → "Guardar API key de Gemini"; queda en las propiedades
 * del script, nunca en el código).
 *
 * PRIVACIDAD: en el nivel gratuito de la API, Google puede usar lo que se le
 * envía para mejorar sus productos. Para mails reales de clientes conviene el
 * nivel pago (con facturación activa) o Gemini dentro de Google Workspace.
 * Además, con ANONIMIZAR activado se tapan CUIT, CBU/CVU, tarjetas y mails
 * antes de enviar el texto al modelo.
 */

var IA = {
  MODELO: 'gemini-3.6-flash',          // cambiarlo si Google lo renombra o se quiere otro
  ETIQUETA: 'Revisar IA',
  HOJA_BANDEJA: 'Bandeja IA',
  DIAS_A_REVISAR: 3,                   // antigüedad máxima de las consultas a responder
  MAX_POR_CORRIDA: 8,                  // tope por ejecución (Apps Script corta a los 6 minutos)
  PAUSA_MS: 4000,                      // entre llamadas, para no pasar el límite por minuto
  MAX_CARACTERES_HISTORIAL: 400000,    // si el historial es más largo, se usan los hilos más recientes
  ANONIMIZAR: true,
  FIRMA: 'Saludos,\nEquipo de Facturación'
};

var ESTADOS = ['Pendiente de revisión', 'Enviado sin cambios', 'Editado y enviado', 'Descartado'];

var COLUMNAS_BANDEJA = [
  'Fecha', 'Mensaje ID', 'Hilo ID', 'Remitente', 'Asunto', 'Consulta', 'Clasificación', 'Tono',
  'Antecedente', 'Alertas', 'Para revisar', 'Borrador', 'Abrir en Gmail', 'Estado',
  'Respondido el', 'Horas hasta responder', 'Coincidencia con el borrador'
];
var C = {};  // índice de cada columna (base 0)
COLUMNAS_BANDEJA.forEach(function (n, i) { C[n] = i; });


// ----------------------------------------------------------------------
// Menú y disparadores
// ----------------------------------------------------------------------
function guardarApiKey() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('API key de Gemini', 'Se guarda en las propiedades del script (no queda en el código).',
    ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() === ui.Button.OK && r.getResponseText().trim()) {
    PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', r.getResponseText().trim());
    ui.alert('Listo. Ya se pueden preparar borradores.');
  }
}

function programarBorradores() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'prepararBorradores'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('prepararBorradores').timeBased().everyHours(1).create();
}


// ----------------------------------------------------------------------
// Corrida principal
// ----------------------------------------------------------------------
function prepararBorradores() {
  var candado = LockService.getScriptLock();
  if (!candado.tryLock(10000)) return;  // ya hay una corrida en curso
  try {
    var clave = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!clave) throw new Error('Falta la API key: menú Mesa de Ayuda → Guardar API key de Gemini.');

    extraerMails();  // el historial al día (no duplica)
    var bandeja = hojaBandeja();
    actualizarEstados(bandeja);

    var yaProcesados = new Set(columna(bandeja, C['Mensaje ID']));
    var pendientes = consultasSinResponder().filter(function (c) { return !yaProcesados.has(c.mensaje.getId()); });
    var historial = indiceHistorial();
    var etiqueta = GmailApp.getUserLabelByName(IA.ETIQUETA) || GmailApp.createLabel(IA.ETIQUETA);

    pendientes.slice(0, IA.MAX_POR_CORRIDA).forEach(function (c, n) {
      if (n > 0) Utilities.sleep(IA.PAUSA_MS);
      try {
        var r = analizarConsulta(c.mensaje, historial, clave);
        var borrador = c.mensaje.createDraftReply(r.borrador);
        c.hilo.addLabel(etiqueta);
        anotar(bandeja, c, r, borrador);
      } catch (e) {
        // Una consulta que falla no frena a las demás; queda registrada para mirarla
        Logger.log('Error con el mensaje ' + c.mensaje.getId() + ': ' + e.message);
        anotar(bandeja, c, { clasificacion: 'Error', tono: '', antecedente: '', alertas: [e.message],
          paraRevisar: 'Responder a mano', borrador: '' }, null);
      }
    });
    Logger.log(Math.min(pendientes.length, IA.MAX_POR_CORRIDA) + ' consultas procesadas, ' +
      Math.max(0, pendientes.length - IA.MAX_POR_CORRIDA) + ' quedan para la próxima corrida');
  } finally {
    candado.releaseLock();
  }
}


/**
 * Conversaciones recientes con el cliente cuyo último mensaje es del cliente
 * (o sea, todavía no se le contestó) y que no tienen ya un borrador.
 */
function consultasSinResponder() {
  var dominio = CONFIG.DOMINIO_CLIENTE;
  var q = 'from:' + dominio + ' (' + CONFIG.PALABRAS_CLAVE.join(' OR ') + ') newer_than:' + IA.DIAS_A_REVISAR + 'd';
  var salida = [];
  GmailApp.search(q).forEach(function (hilo) {
    var mensajes = hilo.getMessages();
    if (mensajes.some(function (m) { return m.isDraft(); })) return;  // alguien ya está respondiendo
    var enviados = mensajes.filter(function (m) { return !m.isDraft() && !m.isInTrash(); });
    var ultimo = enviados[enviados.length - 1];
    if (ultimo && ultimo.getFrom().indexOf(dominio) !== -1) salida.push({ hilo: hilo, mensaje: ultimo });
  });
  return salida;
}


// ----------------------------------------------------------------------
// Análisis de una consulta: IA + controles en código
// ----------------------------------------------------------------------
function analizarConsulta(mensaje, historial, clave) {
  var remitente = direccion(mensaje.getFrom());
  var nombre = nombreDePila(mensaje.getFrom());
  var texto = mensaje.getPlainBody().substring(0, CONFIG.LARGO_RESUMEN * 2);
  var tipos = mensaje.getAttachments().map(function (a) { return a.getContentType(); });
  var captura = tipos.some(function (t) { return t.indexOf('image/') !== -1; }) &&
                !tipos.some(function (t) { return t.indexOf('pdf') !== -1; });

  var expedientes = armarExpedientes(mensaje.getId());
  if (expedientes.length > IA.MAX_CARACTERES_HISTORIAL) {
    expedientes = expedientes.slice(-IA.MAX_CARACTERES_HISTORIAL);
  }
  var prompt = [
    'EXPEDIENTES (conversaciones anteriores con el cliente):', expedientes, '',
    'CONSULTA NUEVA', 'Asunto: ' + mensaje.getSubject(), 'Texto: ' + texto,
    'Adjuntos: ' + (tipos.join(', ') || 'ninguno') + (captura ? '  ⚠ CAPTURA DE PANTALLA SIN PDF' : ''),
    'Nombre para el saludo: ' + (nombre || '(sin nombre: saludar con "Hola:")')
  ].join('\n');
  if (IA.ANONIMIZAR) prompt = anonimizar(prompt);

  var ia = llamarGemini(prompt, clave);

  // --- Controles: no se le cree al modelo lo que se puede verificar ---
  var alertas = [];
  var clasificacion = ia.clasificacion;
  var ant = clasificacion !== 'NUEVA' ? historial[ia.hilo_antecedente] : null;
  if (clasificacion !== 'NUEVA' && !ant) {
    alertas.push('La IA citó un antecedente que no está en el historial (' + ia.hilo_antecedente + '): verificar.');
    clasificacion = 'POSIBLE';
  }
  if (captura) alertas.push('Mandó una captura de pantalla en lugar del comprobante en PDF.');
  var mismaPersona = ant && ant.clientes.indexOf(remitente) !== -1;
  if (mismaPersona) alertas.push('La misma persona ya hizo esta consulta (respondida el ' + ant.fechaRespuesta + ').');

  var tono = (captura || mismaPersona) ? 'Firme y pedagógico' :
             clasificacion === 'REPETIDA' ? 'Cordial con antecedente' :
             clasificacion === 'POSIBLE' ? 'A definir por quien revisa' : 'Cordial';
  if (clasificacion === 'REPETIDA' && ia.tono !== tono) {
    alertas.push('Revisar el tono: corresponde "' + tono + '".');
  }

  var saludo = 'Hola' + (nombre ? ', ' + nombre : '') + ':';
  var borrador;
  if (clasificacion === 'NUEVA') {
    // Sin antecedente no se responde de fondo: no hay de dónde sacar la respuesta
    borrador = saludo + '\n\nRecibimos tu consulta. La estamos revisando con el equipo y te respondemos ' +
               'dentro de las próximas 48 horas hábiles.\n\n' + IA.FIRMA;
  } else if (clasificacion === 'POSIBLE') {
    borrador = '[PARA REVISAR: posible relación con "' + (ant ? ant.asunto : '?') + '"' +
               (ant ? ' (' + ant.fechaRespuesta + ')' : '') + '. Borrar esta línea antes de enviar.]\n\n' + ia.borrador;
  } else {
    borrador = ia.borrador;
  }

  return {
    clasificacion: { REPETIDA: 'Repetida', POSIBLE: 'Posible antecedente', NUEVA: 'Nueva' }[clasificacion],
    tono: tono,
    antecedente: ant ? ant.asunto + ' · respondida el ' + ant.fechaRespuesta + ' · hilo ' + ia.hilo_antecedente : '',
    alertas: alertas,
    paraRevisar: ia.para_revisar || '',
    borrador: borrador
  };
}


var INSTRUCCIONES = [
  'Sos parte del equipo de facturación de un estudio contable. Te paso los expedientes de mails con un cliente',
  'y una consulta nueva. Tu trabajo:',
  '1. Buscá en los expedientes si esa consulta ya se respondió (aunque la haya hecho otra persona o con otras palabras).',
  '   - REPETIDA: hay un antecedente claro. hilo_antecedente = el "ID:" de ese hilo.',
  '   - POSIBLE: hay algo parecido pero no estás seguro. hilo_antecedente = el ID del más parecido.',
  '   - NUEVA: no hay antecedente. hilo_antecedente = "".',
  '2. Redactá el borrador reutilizando SOLO lo que dice la respuesta del antecedente. No inventes fechas, montos,',
  '   plazos ni procedimientos. Si falta un dato, escribí [COMPLETAR: qué falta]. Si la respuesta anterior llevaba',
  '   un adjunto, escribí [ADJUNTAR: qué]. Sacá lo que era propio de aquel caso (por ejemplo, un mes puntual).',
  '3. Tono: "Firme y pedagógico" si mandó una captura sin PDF o si la misma persona ya había preguntado lo mismo',
  '   (respetuoso, recordá el procedimiento y sugerí guardar el mail; nunca irónico). Si no, "Cordial con antecedente".',
  '4. Español rioplatense, trato de vos, sin emojis, máximo 120 palabras. Empezá con el saludo indicado y terminá',
  '   con "' + IA.FIRMA.replace('\n', ' / ') + '" (en dos líneas).',
  '5. En para_revisar anotá lo que una persona tiene que verificar antes de enviar (o "" si nada).',
  'Los datos tapados como [CUIT], [CBU], [TARJETA] o [EMAIL] dejalos así: los completa quien revisa.'
].join('\n');

var ESQUEMA = {
  type: 'OBJECT',
  properties: {
    clasificacion: { type: 'STRING', enum: ['REPETIDA', 'POSIBLE', 'NUEVA'] },
    hilo_antecedente: { type: 'STRING' },
    tono: { type: 'STRING', enum: ['Cordial con antecedente', 'Firme y pedagógico', 'Cordial'] },
    borrador: { type: 'STRING' },
    para_revisar: { type: 'STRING' }
  },
  required: ['clasificacion', 'hilo_antecedente', 'tono', 'borrador', 'para_revisar']
};

function llamarGemini(prompt, clave) {
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + IA.MODELO + ':generateContent';
  var cuerpo = {
    systemInstruction: { parts: [{ text: INSTRUCCIONES }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: ESQUEMA }
  };
  var opciones = {
    method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': clave },
    payload: JSON.stringify(cuerpo), muteHttpExceptions: true
  };
  for (var intento = 1; intento <= 2; intento++) {
    var resp = UrlFetchApp.fetch(url, opciones);
    var codigo = resp.getResponseCode();
    if (codigo === 200) {
      var datos = JSON.parse(resp.getContentText());
      var partes = datos.candidates && datos.candidates[0].content && datos.candidates[0].content.parts;
      if (!partes) throw new Error('Gemini no devolvió texto (posible bloqueo de contenido).');
      var r = JSON.parse(partes[0].text);
      if (ESQUEMA.properties.clasificacion.enum.indexOf(r.clasificacion) === -1 || !r.borrador) {
        throw new Error('Respuesta de Gemini incompleta.');
      }
      return r;
    }
    if ((codigo === 429 || codigo >= 500) && intento === 1) { Utilities.sleep(15000); continue; }
    throw new Error('Gemini respondió ' + codigo + ': ' + resp.getContentText().substring(0, 200));
  }
}


// ----------------------------------------------------------------------
// Historial y bandeja
// ----------------------------------------------------------------------
/** Por hilo: asunto, quiénes del cliente escribieron y cuándo se respondió por primera vez. */
function indiceHistorial() {
  var datos = hojaHistorial().getDataRange().getValues();
  var col = {};
  datos[0].forEach(function (h, i) { col[h] = i; });
  var hilos = {};
  datos.slice(1).forEach(function (f) {
    var id = String(f[col['Hilo ID']]);
    var h = hilos[id] || (hilos[id] = { asunto: f[col['Asunto']], clientes: [], fechaRespuesta: null });
    if (f[col['Dirección']] === 'Recibido (Cliente)') {
      var d = direccion(f[col['Remitente']]);
      if (h.clientes.indexOf(d) === -1) h.clientes.push(d);
    } else if (!h.fechaRespuesta) {
      h.fechaRespuesta = fechaTexto(f[col['Fecha']]).substring(0, 10);
    }
  });
  // Solo sirven como antecedente los hilos que tuvieron respuesta
  Object.keys(hilos).forEach(function (id) { if (!hilos[id].fechaRespuesta) delete hilos[id]; });
  return hilos;
}

function hojaBandeja() {
  var libro = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = libro.getSheetByName(IA.HOJA_BANDEJA);
  if (!hoja) {
    hoja = libro.insertSheet(IA.HOJA_BANDEJA);
    hoja.appendRow(COLUMNAS_BANDEJA);
    hoja.setFrozenRows(1);
    hoja.getRange(1, 1, 1, COLUMNAS_BANDEJA.length).setFontWeight('bold');
  }
  return hoja;
}

function anotar(hoja, c, r, borrador) {
  var link = 'https://mail.google.com/mail/u/0/#all/' + c.hilo.getId();
  hoja.appendRow([
    c.mensaje.getDate(), c.mensaje.getId(), c.hilo.getId(), c.mensaje.getFrom(), c.mensaje.getSubject(),
    c.mensaje.getPlainBody().substring(0, CONFIG.LARGO_RESUMEN).replace(/\n/g, ' '),
    r.clasificacion, r.tono, r.antecedente, r.alertas.join('\n'), r.paraRevisar, r.borrador,
    '', r.clasificacion === 'Error' ? 'Descartado' : ESTADOS[0], '', '', ''
  ]);
  var fila = hoja.getLastRow();
  // Las fórmulas desde Apps Script van con coma, sea cual sea la configuración regional de la hoja
  if (borrador) hoja.getRange(fila, C['Abrir en Gmail'] + 1).setFormula('=HYPERLINK("' + link + '","Abrir")');
  var celda = hoja.getRange(fila, C['Estado'] + 1);
  celda.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(ESTADOS, true).build());
}


/**
 * Para cada consulta pendiente, se fija si ya salió la respuesta y cuánto se
 * parece al borrador. Así se mide cuánto sirve el asistente en el uso real.
 */
function actualizarEstados(hoja) {
  if (hoja.getLastRow() < 2) return;
  var rango = hoja.getRange(2, 1, hoja.getLastRow() - 1, COLUMNAS_BANDEJA.length);
  var filas = rango.getValues();
  var cambio = false;
  filas.forEach(function (f, i) {
    if (f[C['Estado']] !== ESTADOS[0]) return;
    var hilo = GmailApp.getThreadById(String(f[C['Hilo ID']]));
    if (!hilo) return;
    var desde = new Date(f[C['Fecha']]).getTime();
    var respuesta = hilo.getMessages().filter(function (m) {
      return !m.isDraft() && m.getDate().getTime() > desde && m.getFrom().indexOf(CONFIG.DOMINIO_CLIENTE) === -1;
    })[0];
    if (!respuesta) return;
    var parecido = similitud(sinCita(respuesta.getPlainBody()), String(f[C['Borrador']]));
    f[C['Estado']] = parecido >= 0.9 ? ESTADOS[1] : ESTADOS[2];
    f[C['Respondido el']] = respuesta.getDate();
    f[C['Horas hasta responder']] = Math.round((respuesta.getDate().getTime() - desde) / 36e5 * 10) / 10;
    f[C['Coincidencia con el borrador']] = Math.round(parecido * 100) + '%';
    cambio = true;
  });
  // Se reescriben solo los valores (no las fórmulas del link)
  if (cambio) {
    [C['Estado'], C['Respondido el'], C['Horas hasta responder'], C['Coincidencia con el borrador']].forEach(function (k) {
      hoja.getRange(2, k + 1, filas.length, 1).setValues(filas.map(function (f) { return [f[k]]; }));
    });
  }
}


// ----------------------------------------------------------------------
// Utilidades
// ----------------------------------------------------------------------
function anonimizar(t) {
  return t
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[EMAIL]')
    .replace(/\b(20|23|24|27|30|33|34)-?\d{8}-?\d\b/g, '[CUIT]')
    .replace(/\b\d{22}\b/g, '[CBU]')
    .replace(/\b(?:\d[ -]?){15,18}\d\b/g, '[TARJETA]');
}

/** "Juan Pérez <juan.perez@x.com>" → "juan.perez@x.com" */
function direccion(de) {
  var m = String(de).match(/<([^>]+)>/);
  return (m ? m[1] : String(de)).trim().toLowerCase();
}

function nombreDePila(de) {
  var m = String(de).match(/^\s*"?([^"<@]+?)"?\s*</);  // nombre visible, si lo hay
  var base = m ? m[1].split(' ')[0] : direccion(de).split('@')[0].split('.')[0];
  if (['admin', 'administracion', 'compras', 'info', 'facturacion', 'pagos'].indexOf(base.toLowerCase()) !== -1) return '';
  return base.charAt(0).toUpperCase() + base.slice(1).toLowerCase();
}

/** Saca el mail citado ("El ... escribió:" y líneas con ">") de una respuesta. */
function sinCita(t) {
  return String(t).split(/\n(?:El .+escribi[óo]:|On .+wrote:)/)[0]
    .split('\n').filter(function (l) { return l.trim().charAt(0) !== '>'; }).join('\n');
}

/** Parecido entre dos textos (0 a 1): palabras en común sobre el total. */
function similitud(a, b) {
  function palabras(t) {
    return new Set(String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .match(/[a-z0-9]{3,}/g) || []);
  }
  var A = palabras(a), B = palabras(b), comunes = 0;
  A.forEach(function (p) { if (B.has(p)) comunes++; });
  var total = A.size + B.size - comunes;
  return total ? comunes / total : 1;
}

function columna(hoja, indice) {
  if (hoja.getLastRow() < 2) return [];
  return hoja.getRange(2, indice + 1, hoja.getLastRow() - 1, 1).getValues().map(function (f) { return String(f[0]); });
}
