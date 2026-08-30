"""
CafeTrace. Verificacion del optimizador del tablero.

El notebook resuelve el modelo de segregacion con un solver de programacion
entera mixta. El tablero lo resuelve con una mochila binaria en el
navegador, porque tiene que funcionar sin conexion. Son dos
implementaciones del mismo modelo, y este script comprueba que devuelven el
mismo optimo.

Que se compara. Sobre instancias aleatorias se calcula el valor objetivo
que alcanza cada implementacion y se verifica que coincidan, y que la
solucion del tablero cumpla la restriccion de riesgo del contenedor.

Por que importa. La transformacion que usa el tablero para normalizar los
coeficientes negativos de la restriccion es correcta pero no es obvia. Si
estuviera mal, el plan seguiria pareciendo razonable y estaria dejando
valor sobre la mesa o rompiendo la tolerancia sin avisar.

Uso:
    python3 scripts/verificar_optimizador.py
    python3 scripts/verificar_optimizador.py 60
"""

from __future__ import annotations

import json
import random
import subprocess
import sys
import tempfile
from pathlib import Path

import pulp

RAIZ = Path(__file__).resolve().parents[1]
MODULO = RAIZ / "js" / "modules" / "optimizer.js"

PRECIO_ORGANICO = 210.0
PRECIO_CONVENCIONAL = 160.0
LAMBDA_RIESGO = 260.0


def generar_instancia(rng: random.Random, n: int) -> list[dict]:
    """
    Lotes sinteticos con probabilidad conocida. Las coordenadas se separan lo
    suficiente para que la cuarentena espacial no se active: aqui se verifica
    la mochila, y la geometria se comprueba aparte.
    """
    return [
        {
            "ID_Lote": f"L{i:04d}",
            "ID_Productor": f"P{i:04d}",
            "Finca": f"Finca {i}",
            "Empresa_Exportadora": "Prueba",
            "Destino": "Alemania",
            "Peso_Quintales": round(rng.uniform(20, 400), 1),
            "lat": -6.0 - i * 0.05,
            "lon": -78.0 - i * 0.05,
            "Certificacion_Declarada": "Organico",
            "Proximidad_Finca_Convencional": "Baja",
            "Hallazgos": [],
            "Agroquimicos_Detectados": [],
            "Kits_Faltantes": [],
            "p_prueba": round(rng.random(), 4),
        }
        for i in range(n)
    ]


def resolver_con_pulp(lotes: list[dict], alfa: float) -> dict:
    """Optimo exacto de referencia."""
    delta = PRECIO_ORGANICO - PRECIO_CONVENCIONAL
    problema = pulp.LpProblem("verificacion", pulp.LpMaximize)

    X = {l["ID_Lote"]: pulp.LpVariable(f"x_{l['ID_Lote']}", cat="Binary") for l in lotes}

    problema += pulp.lpSum(
        X[l["ID_Lote"]] * l["Peso_Quintales"] * (delta - LAMBDA_RIESGO * l["p_prueba"])
        for l in lotes
    )
    problema += (
        pulp.lpSum(
            X[l["ID_Lote"]] * l["Peso_Quintales"] * (l["p_prueba"] - alfa)
            for l in lotes
        )
        <= 0
    )
    problema.solve(pulp.PULP_CBC_CMD(msg=0, timeLimit=120))

    elegidos = {l["ID_Lote"] for l in lotes if round(X[l["ID_Lote"]].value() or 0) == 1}
    return {
        "estado": pulp.LpStatus[problema.status],
        "objetivo": float(pulp.value(problema.objective) or 0.0),
        "elegidos": elegidos,
    }


ARNES_JS = """
const fs = require('fs');
global.window = global;
global.location = { protocol: 'http:' };
require(process.argv[2]);

const entrada = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const salida = CT.Optimizer.resolver(entrada.lotes, {
  ALFA_CONTENEDOR: entrada.alfa,
  // Se inyecta la probabilidad de la instancia en vez de derivarla de los
  // priors, para comparar exactamente el mismo problema que ve el solver.
  probabilidad: (r) => ({ p: r.p_prueba, origen: 'prueba', detalle: '' })
});

const delta = CT.Optimizer.CONFIG.PRECIO_ORGANICO - CT.Optimizer.CONFIG.PRECIO_CONVENCIONAL;
const objetivo = salida.plan
  .filter((l) => l.exporta)
  .reduce((s, l) => s + l.quintales * (delta - CT.Optimizer.CONFIG.LAMBDA_RIESGO * l.p), 0);

console.log(JSON.stringify({
  objetivo,
  elegidos: salida.plan.filter((l) => l.exporta).map((l) => l.ID_Lote),
  riesgo: salida.riesgoPonderado,
  cumple: salida.cumpleTolerancia,
  quintales: salida.quintalesExportados
}));
"""


def resolver_con_tablero(lotes: list[dict], alfa: float) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        arnes = Path(tmp) / "arnes.js"
        entrada = Path(tmp) / "entrada.json"
        arnes.write_text(ARNES_JS, encoding="utf-8")
        entrada.write_text(json.dumps({"lotes": lotes, "alfa": alfa}), encoding="utf-8")

        proceso = subprocess.run(
            ["node", str(arnes), str(MODULO), str(entrada)],
            capture_output=True, text=True, timeout=180,
        )
        if proceso.returncode != 0:
            raise RuntimeError(f"el arnes de node fallo: {proceso.stderr[:500]}")
        return json.loads(proceso.stdout)


def verificar_geometria() -> bool:
    """
    Comprueba la distancia sobre la esfera del modulo contra un calculo
    independiente en Python, sobre las coordenadas reales del tablero.
    """
    import csv
    import math

    filas = list(csv.DictReader((RAIZ / "data" / "productores.csv").open(encoding="utf-8")))
    puntos = [(f["ID_Productor"], float(f["Coordenadas_Lat"]), float(f["Coordenadas_Lon"]))
              for f in filas]

    arnes = """
global.window = global;
global.location = { protocol: 'http:' };
require(process.argv[2]);
const p = JSON.parse(process.argv[3]);
const out = [];
for (let i = 0; i < p.length; i++)
  for (let j = i + 1; j < p.length; j++)
    out.push(CT.Optimizer.distanciaM(
      { lat: p[i][1], lon: p[i][2] }, { lat: p[j][1], lon: p[j][2] }));
console.log(JSON.stringify(out));
"""
    with tempfile.TemporaryDirectory() as tmp:
        ruta = Path(tmp) / "geo.js"
        ruta.write_text(arnes, encoding="utf-8")
        proceso = subprocess.run(
            ["node", str(ruta), str(MODULO), json.dumps(puntos)],
            capture_output=True, text=True, timeout=60,
        )
        del_js = json.loads(proceso.stdout)

    esperado = []
    for i in range(len(puntos)):
        for j in range(i + 1, len(puntos)):
            la1, lo1 = math.radians(puntos[i][1]), math.radians(puntos[i][2])
            la2, lo2 = math.radians(puntos[j][1]), math.radians(puntos[j][2])
            h = (math.sin((la2 - la1) / 2) ** 2
                 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2)
            esperado.append(2 * 6371000 * math.asin(math.sqrt(h)))

    peor = max(abs(a - b) for a, b in zip(del_js, esperado))
    print(f"  distancias comparadas {len(esperado)}   peor diferencia {peor:.6f} m")
    return peor < 1e-6


def main() -> None:
    n_casos = int(sys.argv[1]) if len(sys.argv) > 1 else 40
    rng = random.Random(20260829)

    print("CafeTrace. Verificacion del optimizador del tablero")
    print(f"  modulo   {MODULO.relative_to(RAIZ)}")
    print(f"  casos    {n_casos}")
    print()

    print("geometria")
    geo_ok = verificar_geometria()
    print(f"  resultado: {'coincide' if geo_ok else 'DIFIERE'}")
    print()

    print("mochila contra solver de programacion entera mixta")
    print(f"  {'caso':>5s} {'n':>4s} {'alfa':>6s} {'objetivo solver':>17s} "
          f"{'objetivo tablero':>17s} {'brecha':>10s} {'riesgo':>8s} ok")

    fallos = 0
    peor_brecha = 0.0

    for caso in range(1, n_casos + 1):
        n = rng.choice([5, 8, 12, 20, 35, 60])
        alfa = rng.choice([0.02, 0.05, 0.08, 0.15, 0.30, 0.50])
        lotes = generar_instancia(rng, n)

        ref = resolver_con_pulp(lotes, alfa)
        tab = resolver_con_tablero(lotes, alfa)

        denominador = max(abs(ref["objetivo"]), 1.0)
        brecha = abs(ref["objetivo"] - tab["objetivo"]) / denominador
        peor_brecha = max(peor_brecha, brecha)

        # Se admite una brecha minuscula por la discretizacion de la mochila.
        ok_valor = brecha < 1e-4
        ok_restriccion = tab["cumple"]
        ok = ok_valor and ok_restriccion
        if not ok:
            fallos += 1

        print(f"  {caso:5d} {n:4d} {alfa:6.2f} {ref['objetivo']:17,.2f} "
              f"{tab['objetivo']:17,.2f} {brecha:10.2e} {tab['riesgo']:8.4f} "
              f"{'si' if ok else 'NO'}")

    print()
    print(f"  peor brecha relativa  {peor_brecha:.3e}")
    print(f"  casos con diferencia  {fallos} de {n_casos}")
    print()
    if fallos == 0 and geo_ok:
        print("  VERIFICADO. El tablero alcanza el mismo optimo que el solver.")
    else:
        print("  HAY DIFERENCIAS. Revisar la transformacion de la mochila.")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
