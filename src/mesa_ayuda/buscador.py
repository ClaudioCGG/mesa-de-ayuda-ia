"""
Búsqueda de antecedentes: ¿esta consulta ya se respondió antes?

Usa similitud de texto (TF-IDF con n-gramas de caracteres + coseno). Los
n-gramas de caracteres toleran sinónimos parciales, errores de tipeo y
variantes ("reenviar", "reenvían", "reenvío"), que es como escriben los
clientes de verdad. No necesita internet ni API.
"""

from __future__ import annotations

import re
import unicodedata

import numpy as np
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

# Palabras que no ayudan a distinguir una consulta de otra
VACIAS = {
    "hola", "buenas", "buen", "dia", "gracias", "por", "favor", "me", "nos", "les", "la", "el", "los", "las",
    "de", "del", "que", "como", "se", "un", "una", "en", "y", "o", "a", "al", "lo", "con", "para", "es",
    "pueden", "puede", "necesito", "necesitamos", "consulta", "urgente", "disculpen", "otra", "vez", "yo",
    "septiembre", "octubre", "agosto", "julio", "junio", "mayo", "abril", "marzo", "febrero", "enero",
    "noviembre", "diciembre", "mes", "este", "hoy", "ayer", "ahi",
}


def normalizar(texto: str) -> str:
    t = unicodedata.normalize("NFKD", str(texto).lower()).encode("ascii", "ignore").decode()
    palabras = re.findall(r"[a-z]+", t)
    return " ".join(p for p in palabras if p not in VACIAS and len(p) > 2)


class BuscadorAntecedentes:
    def __init__(self, casos: pd.DataFrame):
        self.casos = casos.reset_index(drop=True)
        self.vectorizador = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), sublinear_tf=True)
        corpus = (self.casos["asunto"] + " " + self.casos["pregunta"]).map(normalizar)
        self.matriz = self.vectorizador.fit_transform(corpus)

    def buscar(self, texto: str, k: int = 3) -> pd.DataFrame:
        vec = self.vectorizador.transform([normalizar(texto)])
        sims = cosine_similarity(vec, self.matriz).ravel()
        top = np.argsort(-sims)[:k]
        return self.casos.iloc[top].assign(similitud=sims[top]).reset_index(drop=True)
