"""
CafeTrace. Priors de riesgo para lotes con el panel abierto.

Que problema resuelve. El tablero conoce el resultado de los kits que ya se
corrieron, pero tiene que decidir sobre lotes cuyo panel esta incompleto o
sin ejecutar. Para esos lotes hace falta una probabilidad de contaminacion,
y es lo que este script estima.

De donde sale la estimacion. De la data sintetica de la capa procesada, que
tiene el panel completo de cuatro kits sobre 4,200 lotes. Para cada
subconjunto de kits que podria faltar y para cada grupo de proximidad al
lindero convencional, se cuenta que fraccion de lotes tuvo al menos un
hallazgo en ese subconjunto.

Por que la frecuencia conjunta y no el producto de marginales. Los cuatro
kits comparten causa: la deriva del vecino y el equipo de beneficio
compartido elevan a varios a la vez. Suponer independencia condicional
sobreestima el riesgo en un 23 por ciento en el grupo de proximidad alta,
porque cuenta como sucesos separados lo que en realidad ocurre junto. Como
los subconjuntos posibles son solo quince, se estima cada uno directamente
por frecuencia observada y el supuesto de independencia no hace falta.

Salida: data/priors_riesgo.json, que consume el optimizador del tablero.

Uso:
    python3 scripts/calcular_priors.py
"""

from __future__ import annotations

import gc
import itertools
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

RAIZ = Path(__file__).resolve().parents[1]
CLEAN = RAIZ / "data" / "clean"
DESTINO = RAIZ / "data" / "priors_riesgo.json"

KITS = ["Glifosato", "Clorpirifos", "Cipermetrina", "Carbendazim"]

# Probabilidad de que un panel completo y conforme este dejando pasar un
# residuo. No se puede estimar de esta data: aqui la etiqueta se define como
# el resultado del propio panel, de modo que un panel limpio da cero por
# construccion. El valor refleja la sensibilidad declarada de un kit ELISA
# comercial cerca del umbral y es un supuesto de dominio, no una medicion.
SENSIBILIDAD_RESIDUAL = 0.02

# Grupos de proximidad al lindero convencional. El tablero los declara como
# categoria y la data sintetica los tiene como distancia continua, asi que
# se parte por la mediana para que ambos hablen del mismo corte.
GRUPOS = ["Alta", "Baja"]


def cargar() -> tuple[pd.DataFrame, float]:
    lotes = pd.read_csv(CLEAN / "app" / "lotes.csv")
    gis = pd.read_csv(CLEAN / "apis" / "gis_fincas.csv")
    elisa = pd.read_csv(CLEAN / "elisa" / "elisa_lote.csv")

    datos = lotes.merge(gis, on="finca_id").merge(elisa, on="lote_id")
    mediana = float(datos["distancia_vecino_convencional_m"].median())
    datos["proximidad"] = np.where(
        datos["distancia_vecino_convencional_m"] <= mediana, "Alta", "Baja"
    )
    return datos, mediana


def probabilidad_conjunta(sub: pd.DataFrame, faltantes: tuple[str, ...]) -> float:
    """Fraccion de lotes con al menos un hallazgo entre los kits faltantes."""
    columnas = [f"excede_umbral_{k.lower()}" for k in faltantes]
    return float(sub[columnas].max(axis=1).mean())


def main() -> None:
    datos, mediana = cargar()

    subconjuntos = [
        combo
        for tamano in range(1, len(KITS) + 1)
        for combo in itertools.combinations(KITS, tamano)
    ]

    tabla: dict[str, dict[str, float]] = {}
    marginales: dict[str, dict[str, float]] = {}

    for grupo in GRUPOS:
        sub = datos[datos["proximidad"] == grupo]
        tabla[grupo] = {
            "|".join(combo): round(probabilidad_conjunta(sub, combo), 5)
            for combo in subconjuntos
        }
        marginales[grupo] = {
            k: round(float(sub[f"excede_umbral_{k.lower()}"].mean()), 5) for k in KITS
        }

    # Grupo de respaldo para lotes sin proximidad declarada.
    tabla["Global"] = {
        "|".join(combo): round(probabilidad_conjunta(datos, combo), 5)
        for combo in subconjuntos
    }
    marginales["Global"] = {
        k: round(float(datos[f"excede_umbral_{k.lower()}"].mean()), 5) for k in KITS
    }

    salida = {
        "generado_en": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "fuente": "data/clean/elisa/elisa_lote.csv",
        "lotes_base": int(len(datos)),
        "panel": KITS,
        "mediana_distancia_lindero_m": round(mediana, 1),
        "sensibilidad_residual": SENSIBILIDAD_RESIDUAL,
        "nota_metodo": (
            "Frecuencia conjunta observada, no producto de marginales: los "
            "kits comparten causa y el supuesto de independencia sobreestima "
            "el riesgo."
        ),
        "marginales_por_kit": marginales,
        "probabilidad_algun_hallazgo": tabla,
    }

    DESTINO.write_text(
        json.dumps(salida, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    print("CafeTrace. Priors de riesgo para panel abierto")
    print(f"  base            {len(datos):,} lotes")
    print(f"  corte proximidad {mediana:.1f} m")
    print(f"  destino         {DESTINO.relative_to(RAIZ)}")
    print()
    print("probabilidad de al menos un hallazgo segun kits faltantes")
    print(f"  {'kits faltantes':46s} {'Alta':>8s} {'Baja':>8s} {'Global':>8s}")
    for combo in subconjuntos:
        clave = "|".join(combo)
        etiqueta = ", ".join(combo)
        print(
            f"  {etiqueta:46s} "
            f"{tabla['Alta'][clave]:>8.4f} {tabla['Baja'][clave]:>8.4f} "
            f"{tabla['Global'][clave]:>8.4f}"
        )

    print()
    print("comparacion contra el supuesto de independencia, panel completo")
    for grupo in GRUPOS:
        ps = [marginales[grupo][k] for k in KITS]
        independiente = 1.0 - float(np.prod([1.0 - p for p in ps]))
        observado = tabla[grupo]["|".join(KITS)]
        print(
            f"  {grupo:8s} independencia {independiente:.4f}   "
            f"observado {observado:.4f}   "
            f"sobreestimacion {(independiente - observado) / observado:+.1%}"
        )

    del datos
    gc.collect()


if __name__ == "__main__":
    main()
