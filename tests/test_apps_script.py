"""Corre la prueba del Apps Script (Gmail, Sheets y Gemini simulados) si hay Node instalado."""
import shutil
import subprocess

import pytest

from conftest import RAIZ


@pytest.mark.skipif(shutil.which("node") is None, reason="requiere Node.js")
def test_apps_script_borradores_en_gmail():
    r = subprocess.run(["node", str(RAIZ / "apps_script" / "pruebas" / "simulador.test.js")],
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    assert "OK: todas las pruebas" in r.stdout
