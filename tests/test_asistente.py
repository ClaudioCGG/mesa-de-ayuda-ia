import pandas as pd
import pytest

from mesa_ayuda.asistente import Asistente, RedactorPlantillas, respuesta_reutilizable
from mesa_ayuda.buscador import normalizar
from mesa_ayuda.historial import _limpiar_respuesta


def test_normalizar_saca_acentos_meses_y_relleno():
    assert normalizar("Hola, ¿me reenvían la factura de Septiembre? URGENTE") == "reenvian factura"


def test_limpiar_respuesta_saca_saludo_y_firma():
    assert _limpiar_respuesta("Hola, Va adjunta. Saludos, Equipo") == "Va adjunta."


def test_respuesta_reutilizable_saca_frases_del_caso_puntual():
    t = "Se envían el día 5. Les reenviamos la de junio adjunta."
    assert respuesta_reutilizable(t) == "Se envían el día 5."


def test_casos_un_caso_por_hilo_respondido(corrida):
    casos = corrida["casos"]
    assert casos["hilo"].is_unique and len(casos) == 64
    assert casos["respuesta"].str.len().min() > 20


def test_ninguna_repetida_con_antecedente_equivocado(corrida):
    """Lo más importante: no afirmar con confianza algo falso."""
    assert corrida["resumen"]["errores_con_confianza"] == 0


def test_encuentra_todas_las_repetidas(corrida):
    r = corrida["resumen"]
    assert r["repetidas_con_antecedente_correcto"] == r["repetidas_reales"]


def test_desorden_detectado_sin_falsas_alarmas(corrida):
    r = corrida["resumen"]
    assert r["desorden_detectados"] == r["desorden_reales"] and r["falsas_alarmas_desorden"] == 0


def test_consultas_nuevas_no_se_responden_de_fondo(corrida):
    nuevas = corrida["resultados"].query("clasificacion == 'Nueva'")
    assert not nuevas.empty
    assert nuevas["borrador"].str.contains("48 horas hábiles").all()
    assert nuevas["antecedente"].isna().all()


def test_todo_queda_pendiente_de_revision(corrida):
    assert (corrida["resultados"]["estado"] == "Pendiente de revisión").all()


def test_posible_antecedente_se_marca_para_revisar(corrida):
    pos = corrida["resultados"].query("clasificacion == 'Posible antecedente'")
    assert pos["borrador"].str.contains(r"\[PARA REVISAR").all()


def test_screenshot_activa_tono_firme(corrida):
    casos = corrida["casos"]
    consulta = pd.Series({"Asunto": "Pago", "Resumen / Mensaje": "Les mando la captura de la transferencia",
                          "Remitente": "nadie.nuevo@cliente-ejemplo.com", "Fecha": "2026-10-24 10:00",
                          "Mensaje ID": "x1", "Posible Screenshot (sin PDF)": True})
    r = Asistente(casos, RedactorPlantillas()).analizar(consulta)
    assert r.tono == "Firme y pedagógico"
    assert any("captura" in a for a in r.alertas)


@pytest.mark.parametrize("texto", ["¿Cómo liquido sueldos de un empleado de comercio?", "zzz qqq"])
def test_sin_antecedente_es_nueva(corrida, texto):
    consulta = pd.Series({"Asunto": "", "Resumen / Mensaje": texto, "Remitente": "x@cliente-ejemplo.com",
                          "Fecha": "2026-10-24", "Mensaje ID": "x2"})
    r = Asistente(corrida["casos"], RedactorPlantillas()).analizar(consulta)
    assert r.clasificacion == "Nueva"
