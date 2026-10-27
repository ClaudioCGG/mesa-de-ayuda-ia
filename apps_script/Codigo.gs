/**
 * MESA DE AYUDA IA — Paso 1: juntar el historial de mails de un cliente
 *
 * Script vinculado a una Google Sheet. Busca en Gmail los hilos con un cliente
 * sobre un tema (por defecto, facturación), los carga en la hoja sin duplicar
 * y genera un TXT de "expedientes" por hilo, listo para usar como fuente en
 * NotebookLM (o para el asistente en Python de este repositorio).
 *
 * Uso:
 *   1. Abrí la hoja → Extensiones → Apps Script → pegá este archivo (y Borradores.gs).
 *   2. Completá CONFIG con el dominio del cliente.
 *   3. Desde el menú "Mesa de Ayuda" corré "Extraer mails" y "Exportar expedientes".
 *   4. Opcional: "Programar extracción diaria" crea un disparador que corre solo.
 *   5. Opcional: Borradores.gs prepara borradores de respuesta en Gmail (ver ese archivo).
 */

var CONFIG = {
  DOMINIO_CLIENTE: '@cliente-ejemplo.com',               // dominio del cliente (se busca como emisor o receptor)
  NOMBRE_CLIENTE: 'Cliente Ejemplo',                     // solo para el título del TXT
  PALABRAS_CLAVE: ['factura', 'facturacion', 'facturación'],
  LARGO_RESUMEN: 500,                                    // caracteres del cuerpo que se guardan por mensaje
  HORA_DISPARADOR: 7,                                    // hora de la corrida diaria
  HOJA_HISTORIAL: 'Historial'                            // pestaña donde se guardan los mails
};

var ENCABEZADOS = [
  'Fecha', 'Hilo ID', 'Mensaje ID', 'Dirección',
  'Remitente', 'Destinatario', 'Asunto', 'Resumen / Mensaje',
  'Tiene Adjuntos', 'Tipos de Adjuntos', 'Posible Screenshot (sin PDF)'
];


function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Mesa de Ayuda')
    .addItem('Extraer mails', 'extraerMails')
    .addItem('Exportar expedientes (TXT)', 'exportarExpedientes')
    .addSeparator()
    .addItem('Programar extracción diaria', 'programarExtraccionDiaria')
    .addSeparator()
    .addItem('Guardar API key de Gemini', 'guardarApiKey')
    .addItem('Preparar borradores en Gmail', 'prepararBorradores')
    .addItem('Programar borradores cada hora', 'programarBorradores')
    .addToUi();
}


/** La pestaña del historial (se crea si no existe). */
function hojaHistorial() {
  var libro = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = libro.getSheetByName(CONFIG.HOJA_HISTORIAL) || libro.insertSheet(CONFIG.HOJA_HISTORIAL);
  if (hoja.getLastRow() === 0) hoja.appendRow(ENCABEZADOS);
  return hoja;
}


/**
 * Trae a la hoja los mensajes nuevos. Se puede correr todas las veces que se
 * quiera: los mensajes ya cargados se reconocen por su ID y no se duplican.
 */
function extraerMails() {
  var hoja = hojaHistorial();

  // IDs ya cargados
  var existentes = new Set();
  if (hoja.getLastRow() > 1) {
    hoja.getRange(2, 3, hoja.getLastRow() - 1, 1).getValues()
      .forEach(function (fila) { existentes.add(fila[0]); });
  }

  // El cliente participa del hilo (como emisor o receptor) y aparece alguna palabra clave
  var dominio = CONFIG.DOMINIO_CLIENTE;
  var consulta = '(from:' + dominio + ' OR to:' + dominio + ') (' + CONFIG.PALABRAS_CLAVE.join(' OR ') + ')';
  var hilos = GmailApp.search(consulta);
  var filas = [];

  hilos.forEach(function (hilo) {
    hilo.getMessages().forEach(function (msg) {
      var idMsg = msg.getId();
      if (existentes.has(idMsg)) return;

      var de = msg.getFrom();
      var para = msg.getTo();
      var delCliente = de.indexOf(dominio) !== -1;
      var alCliente = para.indexOf(dominio) !== -1;
      if (!delCliente && !alCliente) return;  // control de seguridad: el dominio tiene que estar en el mensaje

      var adjuntos = msg.getAttachments();
      var tipos = adjuntos.map(function (a) { return a.getContentType(); });
      var tieneImagen = tipos.some(function (t) { return t.indexOf('image/') !== -1; });
      var tienePdf = tipos.some(function (t) { return t.indexOf('pdf') !== -1; });

      filas.push([
        msg.getDate(), hilo.getId(), idMsg,
        delCliente ? 'Recibido (Cliente)' : 'Enviado (Nosotros)',
        de, para, msg.getSubject(),
        msg.getPlainBody().substring(0, CONFIG.LARGO_RESUMEN).replace(/\n/g, ' '),
        adjuntos.length > 0, tipos.join(', '),
        tieneImagen && !tienePdf   // el cliente mandó una captura en lugar del comprobante
      ]);
      existentes.add(idMsg);
    });
  });

  if (filas.length > 0) {
    hoja.getRange(hoja.getLastRow() + 1, 1, filas.length, ENCABEZADOS.length).setValues(filas);
  }

  // Cada conversación agrupada y en orden cronológico
  if (hoja.getLastRow() > 1) {
    hoja.getRange(2, 1, hoja.getLastRow() - 1, ENCABEZADOS.length)
      .sort([{ column: 2, ascending: true }, { column: 1, ascending: true }]);
  }
  Logger.log(filas.length + ' mensajes nuevos');
}


/**
 * Arma un TXT con un "expediente" por hilo. Es la fuente que lee NotebookLM
 * (o el asistente en Python) para encontrar antecedentes.
 */
function exportarExpedientes() {
  // Texto plano: se genera mucho más rápido que un Google Doc y NotebookLM lo lee igual
  var nombre = 'Expedientes - ' + CONFIG.NOMBRE_CLIENTE + ' - ' +
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') + '.txt';
  var archivo = DriveApp.createFile(nombre, armarExpedientes(), MimeType.PLAIN_TEXT);
  Logger.log('Archivo creado: ' + archivo.getUrl());
  return archivo.getUrl();
}


/**
 * El texto de los expedientes: un bloque por hilo. Lo usan exportarExpedientes()
 * y prepararBorradores(). `excluirMensaje` deja afuera el mail que se está
 * respondiendo, para que no se cite a sí misma como antecedente.
 */
function armarExpedientes(excluirMensaje) {
  var datos = hojaHistorial().getDataRange().getValues();
  var col = {};
  datos[0].forEach(function (h, i) { col[h] = i; });

  var hilos = {};
  var orden = [];
  datos.slice(1).forEach(function (fila) {
    if (excluirMensaje && fila[col['Mensaje ID']] === excluirMensaje) return;
    var id = fila[col['Hilo ID']];
    if (!hilos[id]) { hilos[id] = []; orden.push(id); }
    hilos[id].push(fila);
  });

  var partes = [
    '=== EXPEDIENTES DE MAILS — ' + CONFIG.NOMBRE_CLIENTE + ' ===',
    'Generado: ' + new Date().toLocaleString(),
    'Total de hilos: ' + orden.length,
    ''
  ];

  orden.forEach(function (id, n) {
    var mensajes = hilos[id];
    partes.push('─────────────────────────────────────────');
    partes.push('HILO #' + (n + 1) + ' — ' + mensajes[0][col['Asunto']]);
    partes.push('ID: ' + id);
    partes.push('Cantidad de mensajes: ' + mensajes.length);
    partes.push('─────────────────────────────────────────');
    mensajes.forEach(function (m, i) {
      partes.push('');
      partes.push('[Mensaje ' + (i + 1) + '] ' + m[col['Dirección']] + ' — ' + fechaTexto(m[col['Fecha']]));
      partes.push('De: ' + m[col['Remitente']]);
      partes.push('Adjuntos: ' + (m[col['Tiene Adjuntos']] ? m[col['Tipos de Adjuntos']] : 'ninguno') +
        (m[col['Posible Screenshot (sin PDF)']] ? '  ⚠ POSIBLE SCREENSHOT SIN PDF ADJUNTO' : ''));
      partes.push('Texto: ' + m[col['Resumen / Mensaje']]);
    });
    partes.push('');
  });
  return partes.join('\n');
}


function fechaTexto(f) {
  return f instanceof Date ? Utilities.formatDate(f, Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm') : String(f);
}


/** Crea (una sola vez) un disparador diario para extraer y exportar sin intervención. */
function programarExtraccionDiaria() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'corridaDiaria'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('corridaDiaria').timeBased().everyDays(1).atHour(CONFIG.HORA_DISPARADOR).create();
}


function corridaDiaria() {
  extraerMails();
  exportarExpedientes();
}
