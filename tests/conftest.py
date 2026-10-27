import sys
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ / "src"))


@pytest.fixture(scope="session")
def corrida():
    from mesa_ayuda.pipeline import correr
    return correr(RAIZ / "data", preferir_ia=False)
