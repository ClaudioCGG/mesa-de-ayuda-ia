/**
 * Prueba del Apps Script fuera de Google: simula Gmail, Sheets y la API de
 * Gemini, y corre el flujo completo de prepararBorradores().
 *
 *     node apps_script/pruebas/simulador.test.js
 *
 * Sin dependencias: solo Node 18+.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const AHORA = Date.now();
const horasAtras = (h) => new Date(AHORA - h * 3600e3);

// ---------------------------------------------------------------- Sheets
class Rango {
  constructor(hoja, f, c, nf = 1, nc = 1) { Object.assign(this, { hoja, f, c, nf, nc }); }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nf; i++) {
      const fila = this.hoja.filas[this.f - 1 + i] || [];
      out.push(Array.from({ length: this.nc }, (_, j) => fila[this.c - 1 + j] ?? ''));
    }
    return out;
  }
  setValues(v) {
    v.forEach((fila, i) => fila.forEach((x, j) => { this.hoja.celda(this.f + i, this.c + j, x); }));
    return this;
  }
  setFormula(x) { this.hoja.celda(this.f, this.c, x); return this; }
  setDataValidation(dv) { this.hoja.validaciones.push([this.f, this.c, dv]); return this; }
  setFontWeight() { return this; }
  sort(criterios) {
    const filas = this.hoja.filas.slice(this.f - 1, this.f - 1 + this.nf);
    filas.sort((a, b) => {
      for (const { column, ascending } of criterios) {
        const x = a[column - 1], y = b[column - 1];
        if (x < y) return ascending ? -1 : 1;
        if (x > y) return ascending ? 1 : -1;
      }
      return 0;
    });
    this.hoja.filas.splice(this.f - 1, this.nf, ...filas);
    return this;
  }
}
class Hoja {
  constructor(nombre) { this.nombre = nombre; this.filas = []; this.validaciones = []; }
  getLastRow() { return this.filas.length; }
  appendRow(f) { this.filas.push([...f]); }
  celda(f, c, x) { while (this.filas.length < f) this.filas.push([]); this.filas[f - 1][c - 1] = x; }
  getRange(f, c, nf, nc) { return new Rango(this, f, c, nf, nc); }
  getDataRange() { return new Rango(this, 1, 1, this.filas.length, Math.max(0, ...this.filas.map((f) => f.length))); }
  setFrozenRows() {}
}
const libro = {
  hojas: {},
  getSheetByName(n) { return this.hojas[n] || null; },
  insertSheet(n) { return (this.hojas[n] = new Hoja(n)); },
};

// ----------------------------------------------------------------- Gmail
let nId = 1;
class Mensaje {
  constructor(hilo, { de, para, fecha, asunto, texto, adjuntos = [], borrador = false }) {
    Object.assign(this, { hilo, de, para, fecha, asunto, texto, adjuntos, borrador, id: 'm' + nId++ });
  }
  getId() { return this.id; }
  getFrom() { return this.de; }
  getTo() { return this.para; }
  getDate() { return this.fecha; }
  getSubject() { return this.asunto; }
  getPlainBody() { return this.texto; }
  getAttachments() { return this.adjuntos.map((t) => ({ getContentType: () => t })); }
  isDraft() { return this.borrador; }
  isInTrash() { return false; }
  createDraftReply(cuerpo) {
    const m = new Mensaje(this.hilo, { de: 'facturacion@estudio-ejemplo.com.ar', para: this.de, fecha: new Date(AHORA),
      asunto: 'RE: ' + this.asunto, texto: cuerpo, borrador: true });
    this.hilo.mensajes.push(m);
    return { getId: () => m.id };
  }
}
class Hilo {
  constructor(id) { this.id = id; this.mensajes = []; this.etiquetas = []; }
  getId() { return this.id; }
  getMessages() { return this.mensajes; }
  addLabel(e) { this.etiquetas.push(e.nombre); }
  agregar(datos) { const m = new Mensaje(this, datos); this.mensajes.push(m); return m; }
}
const hilos = [];
const etiquetas = {};
const GmailApp = {
  search(q) {
    const dias = (q.match(/newer_than:(\d+)d/) || [])[1];
    const claves = ctx.CONFIG.PALABRAS_CLAVE;
    return hilos.filter((h) => h.mensajes.some((m) => {
      if (m.borrador) return false;
      const delCliente = m.de.includes(ctx.CONFIG.DOMINIO_CLIENTE);
      if (q.startsWith('from:') ? !delCliente : !(delCliente || m.para.includes(ctx.CONFIG.DOMINIO_CLIENTE))) return false;
      if (dias && m.fecha < horasAtras(dias * 24)) return false;
      const palabras = (m.asunto + ' ' + m.texto).toLowerCase().split(/[^a-záéíóúñ]+/);
      return claves.some((k) => palabras.includes(k));  // Gmail busca palabras completas
    }));
  },
  getUserLabelByName: (n) => etiquetas[n] || null,
  createLabel: (n) => (etiquetas[n] = { nombre: n }),
  getThreadById: (id) => hilos.find((h) => h.id === id) || null,
};

// ---------------------------------------------------------------- Gemini
const llamadas = [];
let respuestasGemini = {};  // asunto de la consulta → respuesta simulada (o código de error)
const UrlFetchApp = {
  fetch(url, op) {
    const cuerpo = JSON.parse(op.payload);
    const prompt = cuerpo.contents[0].parts[0].text;
    llamadas.push({ url, prompt, clave: op.headers['x-goog-api-key'] });
    const asunto = prompt.match(/CONSULTA NUEVA\nAsunto: (.*)/)[1];
    const r = respuestasGemini[asunto];
    if (typeof r === 'number') return { getResponseCode: () => r, getContentText: () => '{"error":"simulado"}' };
    const texto = JSON.stringify(r);
    return { getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ candidates: [{ content: { parts: [{ text: texto }] } }] }) };
  },
};

// --------------------------------------------------------------- Entorno
const logs = [];
const ctx = vm.createContext({
  SpreadsheetApp: {
    getActiveSpreadsheet: () => libro,
    newDataValidation: () => ({ requireValueInList(l) { this.l = l; return this; }, build() { return { lista: this.l }; } }),
  },
  GmailApp, UrlFetchApp,
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'GEMINI_API_KEY' ? 'clave-de-prueba' : null) }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  Utilities: {
    sleep() {},
    formatDate(d, tz, f) {
      const p = (n) => String(n).padStart(2, '0');
      return f.replace('dd', p(d.getDate())).replace('MM', p(d.getMonth() + 1)).replace('yyyy', d.getFullYear())
        .replace('HH', p(d.getHours())).replace('mm', p(d.getMinutes()));
    },
  },
  Session: { getScriptTimeZone: () => 'America/Argentina/Buenos_Aires' },
  Logger: { log: (x) => logs.push(x) },
  Set, Date, JSON, Math, String, Object, Array, Error,
});
const dir = path.join(__dirname, '..');
vm.runInContext(fs.readFileSync(path.join(dir, 'Codigo.gs'), 'utf8'), ctx, { filename: 'Codigo.gs' });
vm.runInContext(fs.readFileSync(path.join(dir, 'Borradores.gs'), 'utf8'), ctx, { filename: 'Borradores.gs' });

// ----------------------------------------------------------------- Datos
const CLI = (u) => `${u}@cliente-ejemplo.com`;
const EST = 'facturacion@estudio-ejemplo.com.ar';
function conversacion(id, preguntas) {
  const h = new Hilo(id);
  preguntas.forEach((m) => h.agregar(m));
  hilos.push(h);
  return h;
}
// Historial: tres consultas ya respondidas
conversacion('t1', [
  { de: 'Mariela Paz <' + CLI('mariela.paz') + '>', para: EST, fecha: horasAtras(24 * 90), asunto: 'Factura junio',
    texto: '¿Me reenvían la factura de junio?' },
  { de: EST, para: CLI('mariela.paz'), fecha: horasAtras(24 * 89), asunto: 'RE: Factura junio',
    texto: 'Hola, las facturas quedan en la carpeta compartida "Facturas 2026". Saludos', adjuntos: ['application/pdf'] }]);
conversacion('t2', [
  { de: CLI('jonatan.ruiz'), para: EST, fecha: horasAtras(24 * 60), asunto: 'Pago factura proveedor',
    texto: 'Les mando la captura del pago de la factura.', adjuntos: ['image/png'] },
  { de: EST, para: CLI('jonatan.ruiz'), fecha: horasAtras(24 * 59), asunto: 'RE: Pago factura proveedor',
    texto: 'Hola, necesitamos el comprobante en PDF del banco, no una captura. Saludos' }]);
conversacion('t3', [
  { de: CLI('carla.benitez'), para: EST, fecha: horasAtras(24 * 30), asunto: 'Factura con CUIT mal',
    texto: 'La factura salió con el CUIT equivocado.' },
  { de: EST, para: CLI('carla.benitez'), fecha: horasAtras(24 * 29), asunto: 'RE: Factura con CUIT mal',
    texto: 'Hola, se anula con nota de crédito y se emite una nueva. Saludos' }]);

// Bandeja: consultas recientes
const n1 = conversacion('n1', [{ de: 'Romina Díaz <' + CLI('romina.diaz') + '>', para: EST, fecha: horasAtras(5),
  asunto: 'No encuentro la factura', texto: '¿Dónde está la factura de septiembre?' }]);
const n2 = conversacion('n2', [{ de: CLI('jonatan.ruiz'), para: EST, fecha: horasAtras(4),
  asunto: 'Pago factura', texto: 'Ahí va la captura del pago de la factura.', adjuntos: ['image/jpeg'] }]);
conversacion('n3', [{ de: CLI('admin'), para: EST, fecha: horasAtras(3),
  asunto: 'Anticipo', texto: '¿Cómo se hace la factura de un anticipo?' }]);
conversacion('n4', [{ de: CLI('lucas.ferro'), para: EST, fecha: horasAtras(3),
  asunto: 'Factura exterior', texto: 'Tenemos que hacer una factura a Chile.' }]);
conversacion('n5', [  // ya respondida: no se toca
  { de: CLI('carla.benitez'), para: EST, fecha: horasAtras(10), asunto: 'Factura octubre', texto: '¿Sale la factura?' },
  { de: EST, para: CLI('carla.benitez'), fecha: horasAtras(8), asunto: 'RE: Factura octubre', texto: 'Sí, el 5.' }]);
const n6 = conversacion('n6', [  // alguien ya empezó un borrador: no se toca
  { de: CLI('mariela.paz'), para: EST, fecha: horasAtras(6), asunto: 'Factura duplicada', texto: 'Nos llegó la factura dos veces.' }]);
n6.mensajes.push(new Mensaje(n6, { de: EST, para: CLI('mariela.paz'), fecha: horasAtras(1), asunto: 'RE', texto: '...', borrador: true }));
conversacion('n7', [{ de: CLI('admin'), para: EST, fecha: horasAtras(2), asunto: 'Datos factura',
  texto: 'Facturen a CUIT 30-71234567-8, CBU 0170099220000067797370, mail pagos@otra-empresa.com. Es por la factura.' }]);
conversacion('viejo', [{ de: CLI('admin'), para: EST, fecha: horasAtras(24 * 10), asunto: 'Factura vieja',
  texto: 'Consulta de hace 10 días sobre la factura.' }]);

const ok = (clasificacion, hilo, tono, borrador) => ({ clasificacion, hilo_antecedente: hilo, tono, borrador, para_revisar: '' });
respuestasGemini = {
  'No encuentro la factura': ok('REPETIDA', 't1', 'Cordial con antecedente',
    'Hola, Romina:\n\nLas facturas quedan en la carpeta compartida "Facturas 2026".\n\nSaludos,\nEquipo de Facturación'),
  'Pago factura': ok('REPETIDA', 't2', 'Cordial con antecedente',  // el modelo se equivoca de tono a propósito
    'Hola, Jonatan:\n\nNecesitamos el comprobante en PDF del banco, no una captura.\n\nSaludos,\nEquipo de Facturación'),
  'Anticipo': ok('NUEVA', '', 'Cordial', 'Texto que el modelo inventó y no debe usarse'),
  'Factura exterior': ok('REPETIDA', 't99', 'Cordial con antecedente', 'Hola, Lucas:\n\nSe emite factura E.\n\nSaludos'),
  'Datos factura': 503,
};

// --------------------------------------------------------------- Corrida 1
ctx.prepararBorradores();
const bandeja = libro.getSheetByName('Bandeja IA');
const C = ctx.C;
const filas = bandeja.filas.slice(1);
const fila = (hilo) => filas.find((f) => f[C['Hilo ID']] === hilo);

assert.deepStrictEqual(filas.map((f) => f[C['Hilo ID']]).sort(), ['n1', 'n2', 'n3', 'n4', 'n7'],
  'procesa solo las consultas recientes sin responder y sin borrador');
assert.strictEqual(llamadas.length, 6, '5 consultas + 1 reintento por el error 503');
assert.ok(llamadas.every((l) => l.clave === 'clave-de-prueba' && l.url.includes(':generateContent')));

// Repetida de otra persona
assert.strictEqual(fila('n1')[C['Clasificación']], 'Repetida');
assert.strictEqual(fila('n1')[C['Tono']], 'Cordial con antecedente');
assert.match(fila('n1')[C['Antecedente']], /Factura junio · respondida el \d\d\/\d\d\/\d{4} · hilo t1/);
assert.ok(n1.etiquetas.includes('Revisar IA'));
assert.ok(n1.mensajes.some((m) => m.borrador && m.texto.startsWith('Hola, Romina')), 'el borrador queda en el hilo');

// Misma persona + captura → firme, aunque el modelo haya dicho otra cosa
const a2 = fila('n2')[C['Alertas']];
assert.strictEqual(fila('n2')[C['Tono']], 'Firme y pedagógico');
assert.match(a2, /captura de pantalla/);
assert.match(a2, /misma persona ya hizo esta consulta/);
assert.match(a2, /Revisar el tono/);

// Nueva → acuse de recibo fijo, no lo que inventó el modelo
assert.strictEqual(fila('n3')[C['Clasificación']], 'Nueva');
assert.match(fila('n3')[C['Borrador']], /^Hola:\n\nRecibimos tu consulta/);
assert.ok(!fila('n3')[C['Borrador']].includes('inventó'));

// Antecedente inexistente → baja a "Posible" y avisa
assert.strictEqual(fila('n4')[C['Clasificación']], 'Posible antecedente');
assert.match(fila('n4')[C['Alertas']], /no está en el historial \(t99\)/);
assert.match(fila('n4')[C['Borrador']], /^\[PARA REVISAR/);

// Error de la API → se registra y no frena al resto
assert.strictEqual(fila('n7')[C['Clasificación']], 'Error');
assert.strictEqual(fila('n7')[C['Estado']], 'Descartado');
assert.match(fila('n7')[C['Alertas']], /Gemini respondió 503/);

// Anonimización: lo que viaja a Gemini no lleva CUIT, CBU ni mails
const p7 = llamadas.find((l) => l.prompt.includes('Asunto: Datos factura')).prompt;
assert.ok(!/30-71234567-8|0170099220000067797370|@/.test(p7), 'datos sensibles tapados');
assert.match(p7, /\[CUIT\].*\[CBU\].*\[EMAIL\]/);

// La consulta no se cita a sí misma: su propio mensaje no está en los expedientes
const p1 = llamadas.find((l) => l.prompt.includes('Asunto: No encuentro la factura')).prompt;
assert.strictEqual(p1.split('¿Dónde está la factura de septiembre?').length, 2, 'aparece solo como consulta nueva');

// Link y lista desplegable
assert.match(fila('n1')[C['Abrir en Gmail']], /^=HYPERLINK\("https:\/\/mail\.google\.com\/mail\/u\/0\/#all\/n1","Abrir"\)$/);
assert.ok(bandeja.validaciones.length >= 5);

// --------------------------------------------------------------- Corrida 2: idempotente
const antes = llamadas.length;
ctx.prepararBorradores();
assert.strictEqual(libro.getSheetByName('Bandeja IA').filas.length - 1, 5, 'no duplica filas');
assert.strictEqual(llamadas.length, antes, 'no vuelve a llamar a la IA');

// --------------------------------------------------------------- Corrida 3: la persona envió las respuestas
function enviar(hilo, texto, horas) {
  hilo.mensajes = hilo.mensajes.filter((m) => !m.borrador);
  hilo.agregar({ de: EST, para: 'x', fecha: new Date(AHORA + horas * 3600e3), asunto: 'RE', texto });
}
enviar(n1, fila('n1')[C['Borrador']] + '\n\nEl lun, 20 oct escribió:\n> ¿Dónde está la factura?', 1);
enviar(n2, 'Hola Jonatan, por favor mandá el PDF del banco. Gracias.', 2);
ctx.prepararBorradores();
const f = (h) => libro.getSheetByName('Bandeja IA').filas.slice(1).find((x) => x[C['Hilo ID']] === h);
assert.strictEqual(f('n1')[C['Estado']], 'Enviado sin cambios');
assert.strictEqual(f('n1')[C['Coincidencia con el borrador']], '100%');
assert.strictEqual(f('n2')[C['Estado']], 'Editado y enviado');
assert.strictEqual(f('n3')[C['Estado']], 'Pendiente de revisión');
assert.ok(f('n1')[C['Horas hasta responder']] > 5);

// Utilidades
assert.strictEqual(ctx.nombreDePila('"Romina Díaz" <romina.diaz@x.com>'), 'Romina');
assert.strictEqual(ctx.nombreDePila('admin@x.com'), '');
assert.strictEqual(ctx.direccion('Juan <Juan.Perez@X.com>'), 'juan.perez@x.com');

console.log('OK: todas las pruebas del Apps Script pasaron');
console.log(logs.filter((l) => /procesadas|Error/.test(l)).join('\n'));
