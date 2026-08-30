"""
CafeTrace. Generador de data sintetica fisicamente informada.

No genera numeros aleatorios sin sentido: simula la interaccion entre
topografia, meteorologia y practicas agricolas para producir el valor ppm
que un kit ELISA leeria en el centro de acopio.

Cadena de simulacion (ver Arquitectura idea, seccion 1):

    Meteorologia sintetica  +  Mapa GIS sintetico  +  Registro operativo
                    |
                    v
        Modelo fisico de deriva (Gaussian Plume simplificado)
                    |
                    v
        Concentracion residual estimada en ppm
                    |
                    v  (ruido blanco del inmunoensayo)
        Target ELISA simulado (cuantitativo y binario)

Formulas implementadas:

    Deriva por viento
        C_residual = C0 * exp(menos d^2 / (2 * sigma_y^2)) * cos(theta_viento)

    Contaminacion cruzada operativa
        Riesgo_herramienta = Bernoulli(p = 0.8 si compartio equipo sin lavar)

    Target ELISA
        ELISA_cuant  = max(0, C_residual + Riesgo_herramienta + epsilon)
        ELISA_binario = 1 si ELISA_cuant >= LOD

Salidas. Crudos en data/raw y procesados en data/clean, separados por
fuente de datos (app, apis, elisa).

Uso:
    python3 scripts/generar_data_sintetica.py
    python3 scripts/generar_data_sintetica.py 120 3000 20260829
        (fincas, lotes, semilla)
"""

from __future__ import annotations

import gc
import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

RAIZ = Path(__file__).resolve().parents[1]
RAW = RAIZ / "data" / "raw"
CLEAN = RAIZ / "data" / "clean"

# ---------------------------------------------------------------------------
# Panel de agroquimicos. Debe permanecer sincronizado con PANEL en
# js/data_loader del tablero: mismos nombres, mismos umbrales, misma lectura.
# ---------------------------------------------------------------------------
PANEL = [
    {
        "agroquimico": "Glifosato",
        "clase": "Herbicida",
        "kit": "ELISA_GLY_96",
        "tipo_lectura": "Cuantitativo",
        "umbral_ppm": 0.10,
        "lod_ppm": 0.01,
        # Probabilidad de que la finca convencional vecina lo aplique en la
        # campana, y dosis tipica en el lindero.
        "p_uso_vecino": 0.62,
        "dosis_lindero": 2.20,
        # Persistencia relativa del residuo en el grano tras el beneficio.
        "persistencia": 1.00,
        # Afinidad del residuo a quedarse en equipo de beneficio compartido.
        "afinidad_equipo": 0.55,
    },
    {
        "agroquimico": "Clorpirifos",
        "clase": "Insecticida organofosforado",
        "kit": "ELISA_CPF_96",
        "tipo_lectura": "Cuantitativo",
        "umbral_ppm": 0.05,
        "lod_ppm": 0.005,
        "p_uso_vecino": 0.44,
        "dosis_lindero": 1.10,
        "persistencia": 0.85,
        "afinidad_equipo": 0.70,
    },
    {
        "agroquimico": "Cipermetrina",
        "clase": "Insecticida piretroide",
        "kit": "ELISA_PYR_48",
        "tipo_lectura": "Cualitativo",
        # El kit cualitativo no entrega magnitud: su criterio operativo es el
        # propio limite de deteccion.
        "umbral_ppm": None,
        "lod_ppm": 0.045,
        "p_uso_vecino": 0.38,
        "dosis_lindero": 0.90,
        "persistencia": 0.70,
        "afinidad_equipo": 0.80,
    },
    {
        "agroquimico": "Carbendazim",
        "clase": "Fungicida bencimidazol",
        "kit": "ELISA_CBZ_96",
        "tipo_lectura": "Cuantitativo",
        "umbral_ppm": 0.10,
        "lod_ppm": 0.01,
        "p_uso_vecino": 0.35,
        "dosis_lindero": 1.40,
        "persistencia": 0.95,
        "afinidad_equipo": 0.45,
    },
]

EXPORTADORAS = ["Perhusa", "Coop. Norandino", "Olam Peru", "Cenfrocafe"]
VARIEDADES = ["Caturra", "Bourbon", "Typica", "Catimor", "Geisha"]
DESTINOS = [
    "Alemania",
    "Belgica",
    "Francia",
    "Paises_Bajos",
    "Estados_Unidos",
    "Japon",
    "Nacional",
]
TECNICOS = [f"TEC{n:02d}" for n in range(1, 13)]
LABORATORIOS = ["LAB Acopio Norte", "LAB Acopio Sur", "LAB Movil Campana"]

# Centro de la zona cafetalera simulada. Rodriguez de Mendoza, Amazonas.
LAT_CENTRO = -6.2300
LON_CENTRO = -77.8600


# ===========================================================================
# 1. Capa GIS. Fincas, topografia y vecindad con parcelas convencionales
# ===========================================================================
def generar_fincas(rng: np.random.Generator, n_fincas: int) -> pd.DataFrame:
    """
    Fincas distribuidas sobre la cuenca, con la geometria que alimenta el
    modelo de deriva: distancia al vecino convencional, azimut de esa
    vecindad, pendiente y altitud.
    """
    ids = [f"F{n:04d}" for n in range(1, n_fincas + 1)]

    # Una de cada cinco parcelas de la cuenca es convencional. Son la fuente
    # de la deriva, no su victima.
    es_convencional = rng.random(n_fincas) < 0.20

    lat = LAT_CENTRO + rng.normal(0, 0.045, n_fincas)
    lon = LON_CENTRO + rng.normal(0, 0.050, n_fincas)

    # Altitud tipica del cafe de altura peruano.
    altitud = rng.normal(1650, 240, n_fincas).clip(900, 2300)

    # Pendiente. Las laderas empinadas favorecen escorrentia hacia abajo.
    pendiente = rng.gamma(shape=3.0, scale=6.0, size=n_fincas).clip(1, 65)

    area = rng.lognormal(mean=0.55, sigma=0.62, size=n_fincas).clip(0.3, 14)

    # Distancia al lindero convencional mas cercano. Log normal: muchas
    # fincas colindan de cerca y una cola larga esta realmente aislada.
    distancia = rng.lognormal(mean=5.25, sigma=0.85, size=n_fincas).clip(8, 2600)

    # Azimut de la parcela convencional vista desde la finca organica.
    azimut = rng.uniform(0, 360, n_fincas)

    # Barrera viva. Cortina rompeviento sembrada en el lindero.
    prob_barrera = np.where(distancia < 150, 0.45, 0.22)
    barrera = rng.random(n_fincas) < prob_barrera

    df = pd.DataFrame(
        {
            "finca_id": ids,
            "es_convencional": es_convencional,
            "certificacion": np.where(es_convencional, "Convencional", "Organico"),
            "empresa_exportadora": rng.choice(EXPORTADORAS, n_fincas),
            "lat": np.round(lat, 6),
            "lon": np.round(lon, 6),
            "altitud_m": np.round(altitud, 1),
            "pendiente_pct": np.round(pendiente, 2),
            "area_ha": np.round(area, 2),
            "distancia_vecino_convencional_m": np.round(distancia, 1),
            "azimut_vecino_deg": np.round(azimut, 1),
            "tiene_barrera_viva": barrera,
            "anios_certificacion": rng.integers(0, 15, n_fincas),
        }
    )

    # Una finca convencional no tiene vecino convencional que la contamine:
    # ella es el origen. Se anula para no inyectar una variable fantasma.
    df.loc[df["es_convencional"], "distancia_vecino_convencional_m"] = 0.0
    df.loc[df["es_convencional"], "tiene_barrera_viva"] = False
    df.loc[df["es_convencional"], "anios_certificacion"] = 0

    # Que agroquimicos aplica realmente el vecino de cada finca. Es la
    # variable latente que el modelo nunca observa y que debe inferir a
    # partir del entorno.
    for agro in PANEL:
        col = f"vecino_usa_{agro['agroquimico'].lower()}"
        df[col] = rng.random(n_fincas) < agro["p_uso_vecino"]

    return df


# ===========================================================================
# 2. Capa APIs. Meteorologia diaria por finca
# ===========================================================================
def generar_meteo(
    rng: np.random.Generator, fincas: pd.DataFrame, fechas: pd.DatetimeIndex
) -> pd.DataFrame:
    """
    Serie meteorologica diaria por finca, con estacionalidad de selva alta.

    El viento manda en el modelo de deriva por dos vias: la velocidad
    controla el ancho de la pluma y la direccion decide si el lindero
    convencional queda a favor o en contra.
    """
    n_f = len(fincas)
    n_d = len(fechas)

    dia_del_anio = fechas.dayofyear.to_numpy()
    # Temporada seca peruana entre mayo y septiembre.
    estacion = np.cos(2 * math.pi * (dia_del_anio - 15) / 365.0)

    filas = []
    for i, finca_id in enumerate(fincas["finca_id"].to_numpy()):
        altitud = fincas["altitud_m"].iloc[i]

        # Viento. Mas fuerte en temporada seca y en cotas altas.
        base_viento = 7.5 + 2.6 * estacion + (altitud - 1650) / 400.0
        viento = rng.gamma(shape=4.0, scale=base_viento / 4.0, size=n_d).clip(0.3, 42)

        # Direccion dominante por finca mas dispersion diaria.
        dir_dominante = rng.uniform(0, 360)
        direccion = (dir_dominante + rng.normal(0, 55, n_d)) % 360

        temperatura = (
            24.5 - (altitud - 1500) / 165.0 + 2.2 * estacion + rng.normal(0, 1.7, n_d)
        )

        # Precipitacion. Cero la mayoria de dias secos, cola exponencial.
        p_lluvia = np.clip(0.52 - 0.30 * estacion, 0.06, 0.92)
        llueve = rng.random(n_d) < p_lluvia
        precipitacion = np.where(llueve, rng.exponential(9.5, n_d), 0.0).clip(0, 120)

        humedad = (78 - 7.5 * estacion + 0.30 * precipitacion + rng.normal(0, 5, n_d)).clip(
            35, 100
        )

        filas.append(
            pd.DataFrame(
                {
                    "finca_id": finca_id,
                    "fecha": fechas,
                    "velocidad_viento_kmh": np.round(viento, 2),
                    "direccion_viento_deg": np.round(direccion, 1),
                    "temperatura_c": np.round(temperatura, 2),
                    "humedad_relativa_pct": np.round(humedad, 1),
                    "precipitacion_mm": np.round(precipitacion, 2),
                }
            )
        )

    meteo = pd.concat(filas, ignore_index=True)
    del filas
    gc.collect()
    return meteo


# ===========================================================================
# 3. Capa App. Lotes cosechados y cuaderno de campo digital
# ===========================================================================
def generar_lotes(
    rng: np.random.Generator,
    fincas: pd.DataFrame,
    fechas: pd.DatetimeIndex,
    n_lotes: int,
) -> pd.DataFrame:
    """
    Lotes consolidados. Solo las fincas organicas entran al flujo de
    exportacion verificada, que es la poblacion del problema.
    """
    organicas = fincas.loc[~fincas["es_convencional"], "finca_id"].to_numpy()
    finca_de_lote = rng.choice(organicas, n_lotes)

    # La cosecha se concentra entre abril y septiembre.
    peso_fecha = np.where(
        (fechas.month >= 4) & (fechas.month <= 9), 6.0, 1.0
    ).astype(float)
    peso_fecha = peso_fecha / peso_fecha.sum()
    idx_fecha = rng.choice(len(fechas), n_lotes, p=peso_fecha)
    fecha_cosecha = fechas[idx_fecha]

    peso = rng.gamma(shape=4.5, scale=32.0, size=n_lotes).clip(25, 460)

    return pd.DataFrame(
        {
            "lote_id": [f"L{n:06d}" for n in range(1, n_lotes + 1)],
            "finca_id": finca_de_lote,
            "fecha_cosecha": fecha_cosecha,
            "peso_quintales": np.round(peso, 1),
            "variedad": rng.choice(VARIEDADES, n_lotes, p=[0.30, 0.22, 0.18, 0.24, 0.06]),
            "destino_previsto": rng.choice(
                DESTINOS, n_lotes, p=[0.22, 0.14, 0.15, 0.13, 0.16, 0.08, 0.12]
            ),
            "dias_secado_patio": rng.integers(4, 21, n_lotes),
        }
    )


def generar_registros_campo(
    rng: np.random.Generator, lotes: pd.DataFrame, fincas: pd.DataFrame
) -> pd.DataFrame:
    """
    Cuaderno de campo digital. Un registro por lote, capturado por el
    tecnico en el momento de la entrega en acopio.

    Estas son las variables operativas que la plataforma si controla, a
    diferencia del clima y la vecindad, que solo puede observar.
    """
    n = len(lotes)
    mapa_finca = fincas.set_index("finca_id")

    distancia = mapa_finca.loc[lotes["finca_id"], "distancia_vecino_convencional_m"].to_numpy()

    # Cuanto mas cerca esta el lindero convencional, mas probable es que el
    # tecnico haya visto o sabido de una fumigacion reciente.
    p_fumigo = np.clip(0.68 * np.exp(-distancia / 420.0), 0.03, 0.72)
    sorteo = rng.random(n)
    vecino_fumigo = np.where(
        sorteo < p_fumigo, "Si", np.where(sorteo < p_fumigo + 0.25, "No_se_sabe", "No")
    )

    dias_desde_fumigacion = np.where(
        vecino_fumigo == "Si", rng.integers(1, 45, n), -1
    )

    # Practicas de beneficio. La cooperativa capacitada comparte menos y
    # lava mas: es el canal accionable del modelo.
    capacitacion = rng.random(n) < 0.55
    p_despulpadora = np.where(capacitacion, 0.22, 0.58)
    despulpadora = rng.random(n) < p_despulpadora
    p_sacos = np.where(capacitacion, 0.18, 0.47)
    sacos = rng.random(n) < p_sacos
    p_lavado = np.where(capacitacion, 0.86, 0.41)
    lavado = rng.random(n) < p_lavado
    patio = rng.random(n) < np.where(capacitacion, 0.25, 0.52)
    transporte = rng.random(n) < 0.38

    herramientas_compartidas = despulpadora | sacos | patio | transporte

    return pd.DataFrame(
        {
            "registro_id": [f"RC{n_:07d}" for n_ in range(1, n + 1)],
            "lote_id": lotes["lote_id"].to_numpy(),
            "finca_id": lotes["finca_id"].to_numpy(),
            "fecha_registro": lotes["fecha_cosecha"].to_numpy(),
            "tecnico_id": rng.choice(TECNICOS, n),
            "vecino_fumigo_reciente": vecino_fumigo,
            "dias_desde_fumigacion_vecina": dias_desde_fumigacion,
            "despulpadora_compartida": despulpadora,
            "sacos_reutilizados": sacos,
            "secado_patio_compartido": patio,
            "transporte_compartido": transporte,
            "herramientas_compartidas_flag": herramientas_compartidas,
            "lavado_equipo_flag": lavado,
            "capacitacion_bpa_flag": capacitacion,
            "lat_gps": np.round(
                mapa_finca.loc[lotes["finca_id"], "lat"].to_numpy()
                + rng.normal(0, 0.0006, n),
                6,
            ),
            "lon_gps": np.round(
                mapa_finca.loc[lotes["finca_id"], "lon"].to_numpy()
                + rng.normal(0, 0.0006, n),
                6,
            ),
            "origen_captura": rng.choice(
                ["formulario_campo", "dashboard_acopio", "cola_kafka"],
                n,
                p=[0.55, 0.25, 0.20],
            ),
        }
    )


# ===========================================================================
# 4. Modelo fisico de deriva y target ELISA
# ===========================================================================
def ventana_meteo(meteo: pd.DataFrame, dias: int = 15) -> pd.DataFrame:
    """
    Resume la meteorologia de la ventana de aplicacion previa a la cosecha.

    La deriva no depende del clima del dia de la entrega sino del clima
    durante el que el vecino aplico. Se promedia hacia atras por finca.
    """
    meteo = meteo.sort_values(["finca_id", "fecha"])
    g = meteo.groupby("finca_id", observed=True)

    # Componentes vectoriales del viento. Promediar grados directamente
    # daria un promedio sin sentido entre 350 y 10 grados.
    rad = np.deg2rad(meteo["direccion_viento_deg"].to_numpy())
    meteo = meteo.assign(
        viento_u=meteo["velocidad_viento_kmh"].to_numpy() * np.sin(rad),
        viento_v=meteo["velocidad_viento_kmh"].to_numpy() * np.cos(rad),
    )
    g = meteo.groupby("finca_id", observed=True)

    roll = lambda col, fn: (
        g[col].transform(lambda s: getattr(s.rolling(dias, min_periods=1), fn)())
    )

    meteo["viento_medio_kmh"] = roll("velocidad_viento_kmh", "mean")
    meteo["viento_max_kmh"] = roll("velocidad_viento_kmh", "max")
    meteo["viento_u_medio"] = roll("viento_u", "mean")
    meteo["viento_v_medio"] = roll("viento_v", "mean")
    meteo["precipitacion_acum_mm"] = roll("precipitacion_mm", "sum")
    meteo["temperatura_media_c"] = roll("temperatura_c", "mean")
    meteo["humedad_media_pct"] = roll("humedad_relativa_pct", "mean")

    # Direccion resultante del viento en la ventana.
    meteo["direccion_media_deg"] = (
        np.rad2deg(np.arctan2(meteo["viento_u_medio"], meteo["viento_v_medio"])) % 360
    )

    # Dias secos consecutivos hasta la fecha. Sin lluvia el residuo persiste.
    seco = (meteo["precipitacion_mm"] < 1.0).astype(int)
    meteo["dias_sin_lluvia"] = seco.groupby(meteo["finca_id"]).transform(
        lambda s: s.groupby((s == 0).cumsum()).cumsum()
    )

    cols = [
        "finca_id",
        "fecha",
        "viento_medio_kmh",
        "viento_max_kmh",
        "direccion_media_deg",
        "precipitacion_acum_mm",
        "temperatura_media_c",
        "humedad_media_pct",
        "dias_sin_lluvia",
    ]
    return meteo[cols].copy()


def simular_elisa(
    rng: np.random.Generator,
    lotes: pd.DataFrame,
    fincas: pd.DataFrame,
    campo: pd.DataFrame,
    meteo_win: pd.DataFrame,
) -> pd.DataFrame:
    """
    Aplica el modelo fisico y devuelve una fila por lote y agroquimico.

    Para cada par lote y agroquimico se calcula la concentracion residual
    por deriva, se suma el aporte por contaminacion cruzada operativa, se
    inyecta ruido blanco del inmunoensayo y se compara contra el limite de
    deteccion y contra el umbral del kit.
    """
    base = (
        lotes.merge(fincas, on="finca_id", how="left", suffixes=("", "_finca"))
        .merge(campo.drop(columns=["finca_id", "fecha_registro"]), on="lote_id", how="left")
        .merge(
            meteo_win,
            left_on=["finca_id", "fecha_cosecha"],
            right_on=["finca_id", "fecha"],
            how="left",
        )
    )

    n = len(base)

    d = base["distancia_vecino_convencional_m"].to_numpy()
    v = base["viento_medio_kmh"].to_numpy()
    dir_viento = base["direccion_media_deg"].to_numpy()
    azimut = base["azimut_vecino_deg"].to_numpy()

    # Angulo entre la direccion del viento y la linea que va del lindero
    # convencional a la finca organica. Solo la componente a favor arrastra.
    theta = np.deg2rad((dir_viento - azimut + 180.0) % 360.0)
    coseno = np.clip(np.cos(theta), 0.0, 1.0)

    # Geometria de la pluma. Se descompone la distancia al lindero en su
    # componente a favor del viento y su componente transversal, que es la
    # que entra en la exponencial gaussiana del enunciado.
    #
    #     y = d * sin(theta)     desplazamiento transversal al eje del viento
    #     x = d * cos(theta)     recorrido a favor del viento
    #
    # La exponencial castiga el desalineamiento y el termino de dilucion
    # castiga la distancia recorrida. Una pluma real es angosta: solo los
    # linderos bien alineados con el viento dominante aportan residuo.
    d_efectiva = np.maximum(d, 1.0)
    y_transversal = d_efectiva * np.abs(np.sin(theta))

    # Ancho de pluma segun estabilidad atmosferica. Mas viento, mas mezcla
    # turbulenta y por tanto pluma mas ancha y mas perdonadora.
    # El coeficiente 0.45 deja una razon sigma sobre distancia cercana a 0.3
    # en el rango corto, que corresponde a una atmosfera moderadamente
    # inestable, la condicion tipica de un valle calido por la tarde.
    sigma_y = np.maximum(8.0, 0.45 * np.power(d_efectiva, 0.90) * (1.0 + 0.030 * v))
    atenuacion_transversal = np.exp(
        -np.square(y_transversal) / (2.0 * np.square(sigma_y))
    )

    # Dilucion a favor del viento respecto de la distancia de referencia de
    # ciento veinte metros, que es la distancia a la que se caracteriza la
    # deriva en los ensayos de campo. El exponente cercano a uno equivale a
    # una caida casi lineal de la concentracion con el recorrido.
    dilucion = np.power(120.0 / np.maximum(d_efectiva, 120.0), 0.9)

    atenuacion_distancia = atenuacion_transversal * dilucion

    # Transporte. Sin viento no hay arrastre por mucho que la pluma sea ancha.
    transporte = 1.0 - np.exp(-v / 5.5)

    # Lavado por lluvia acumulada en la ventana de aplicacion. La escala se
    # fija en 140 mm, que es el orden de la precipitacion quincenal de selva
    # alta: con menos, la lluvia borraba el canal de deriva por completo.
    lavado_lluvia = np.exp(-base["precipitacion_acum_mm"].to_numpy() / 140.0)

    # Escorrentia por ladera. La pendiente concentra residuo cuesta abajo.
    factor_pendiente = 1.0 + base["pendiente_pct"].to_numpy() / 130.0

    # Cortina rompeviento en el lindero.
    factor_barrera = np.where(base["tiene_barrera_viva"].to_numpy(), 0.34, 1.0)

    # Decaimiento desde la fumigacion declarada por el tecnico.
    # Decaimiento desde la fumigacion declarada. Cuando el tecnico responde
    # que no sabe, no se asume ausencia de aplicacion: se asume una
    # aplicacion de momento desconocido, que es lo que realmente ocurre.
    dias_fum = base["dias_desde_fumigacion_vecina"].to_numpy().astype(float)
    factor_fumigacion = np.where(dias_fum >= 0, np.exp(-dias_fum / 45.0), 0.55)

    # Persistencia por dias secos. Sin lluvia el residuo no se degrada.
    factor_seco = 1.0 + base["dias_sin_lluvia"].to_numpy() / 45.0

    # Aporte operativo. La probabilidad 0.8 del enunciado se aplica cuando
    # hubo despulpadora compartida sin lavado posterior.
    equipo_sucio = base["despulpadora_compartida"].to_numpy() & (
        ~base["lavado_equipo_flag"].to_numpy()
    )
    p_operativo = np.where(equipo_sucio, 0.80, 0.04)
    p_operativo = np.where(
        base["sacos_reutilizados"].to_numpy() & ~equipo_sucio,
        0.34,
        p_operativo,
    )
    p_operativo = np.where(
        base["secado_patio_compartido"].to_numpy() & (p_operativo < 0.34),
        0.22,
        p_operativo,
    )

    filas = []
    for agro in PANEL:
        nombre = agro["agroquimico"]
        col_uso = f"vecino_usa_{nombre.lower()}"
        usa = base[col_uso].to_numpy()

        # C0. Dosis en el lindero, con variabilidad de aplicacion.
        c0 = agro["dosis_lindero"] * rng.lognormal(0.0, 0.42, n) * usa

        deriva = (
            c0
            * atenuacion_distancia
            # La raiz suaviza la proyeccion sobre el eje del viento. El
            # desalineamiento ya lo castiga la gaussiana transversal, y
            # aplicarlo dos veces en su forma plena anulaba la deriva.
            * np.sqrt(coseno)
            * transporte
            * lavado_lluvia
            * factor_pendiente
            * factor_barrera
            * factor_fumigacion
            * factor_seco
            * agro["persistencia"]
        )

        # Contaminacion cruzada operativa. Bernoulli por la magnitud que
        # arrastra el equipo, ponderada por la afinidad del residuo.
        bernoulli = rng.random(n) < p_operativo
        magnitud = rng.lognormal(mean=-2.95, sigma=0.80, size=n)
        operativo = bernoulli * magnitud * agro["afinidad_equipo"] * agro["persistencia"]

        # Ruido blanco del inmunoensayo.
        epsilon = rng.normal(0.0, agro["lod_ppm"] * 0.45, n)

        ppm = np.maximum(0.0, deriva + operativo + epsilon)

        detectado = ppm >= agro["lod_ppm"]
        if agro["umbral_ppm"] is None:
            # Kit cualitativo. Su criterio operativo es la propia deteccion.
            excede = detectado
        else:
            excede = ppm > agro["umbral_ppm"]

        filas.append(
            pd.DataFrame(
                {
                    "lote_id": base["lote_id"].to_numpy(),
                    "finca_id": base["finca_id"].to_numpy(),
                    "agroquimico": nombre,
                    "kit": agro["kit"],
                    "tipo_lectura": agro["tipo_lectura"],
                    "ppm_detectado": np.round(ppm, 5),
                    "lod_ppm": agro["lod_ppm"],
                    "umbral_ppm": np.full(
                        n, np.nan if agro["umbral_ppm"] is None else agro["umbral_ppm"],
                        dtype=float,
                    ),
                    "is_detectado": detectado,
                    "excede_umbral": excede,
                    "aporte_deriva": np.round(deriva, 5),
                    "aporte_operativo": np.round(operativo, 5),
                    "fecha_muestreo": base["fecha_cosecha"].to_numpy(),
                }
            )
        )

    elisa = pd.concat(filas, ignore_index=True)
    del filas
    gc.collect()

    elisa.insert(0, "muestra_id", [f"M{n_:07d}" for n_ in range(1, len(elisa) + 1)])
    elisa["laboratorio"] = rng.choice(LABORATORIOS, len(elisa))
    elisa["operador"] = rng.choice(TECNICOS, len(elisa))

    # El kit cualitativo no entrega magnitud. Se preserva el dato fisico en
    # una columna aparte para trazabilidad de la simulacion, pero la columna
    # que el laboratorio reporta queda vacia, igual que en operacion real.
    cualitativos = elisa["tipo_lectura"] == "Cualitativo"
    elisa["ppm_simulado_interno"] = elisa["ppm_detectado"]
    elisa.loc[cualitativos, "ppm_detectado"] = np.nan

    return elisa


# ===========================================================================
# 5. Capa clean. Tipado, deduplicacion y tablas listas para el pipeline
# ===========================================================================
def limpiar_fincas(fincas: pd.DataFrame) -> pd.DataFrame:
    df = fincas.copy()
    for col in ["es_convencional", "tiene_barrera_viva"] + [
        f"vecino_usa_{a['agroquimico'].lower()}" for a in PANEL
    ]:
        df[col] = df[col].astype(int)
    return df


def limpiar_campo(campo: pd.DataFrame) -> pd.DataFrame:
    """
    Booleanos a entero y derivadas operativas que el modelo puede usar
    directamente sin recalcular.
    """
    df = campo.copy()
    bool_cols = [
        "despulpadora_compartida",
        "sacos_reutilizados",
        "secado_patio_compartido",
        "transporte_compartido",
        "herramientas_compartidas_flag",
        "lavado_equipo_flag",
        "capacitacion_bpa_flag",
    ]
    for col in bool_cols:
        df[col] = df[col].astype(int)

    # Indice operativo. Cuantas practicas de riesgo se acumulan en el lote.
    df["practicas_riesgo_conteo"] = (
        df["despulpadora_compartida"]
        + df["sacos_reutilizados"]
        + df["secado_patio_compartido"]
        + df["transporte_compartido"]
    )

    # El cruce que dispara la Bernoulli de 0.8 del modelo fisico.
    df["equipo_compartido_sin_lavar"] = (
        df["despulpadora_compartida"] & (1 - df["lavado_equipo_flag"])
    ).astype(int)

    df["fumigacion_declarada"] = (df["vecino_fumigo_reciente"] == "Si").astype(int)
    df["fumigacion_desconocida"] = (
        df["vecino_fumigo_reciente"] == "No_se_sabe"
    ).astype(int)

    return df


def limpiar_meteo(meteo_win: pd.DataFrame) -> pd.DataFrame:
    df = meteo_win.copy()
    df = df.drop_duplicates(subset=["finca_id", "fecha"])
    for col in df.columns:
        if col not in ("finca_id", "fecha"):
            df[col] = pd.to_numeric(df[col], errors="coerce").round(3)
    return df


def limpiar_elisa(elisa: pd.DataFrame) -> pd.DataFrame:
    """
    Tabla ELISA a nivel de lote. Una fila por lote y una columna por kit,
    mas la etiqueta de negocio que consume el motor de reglas del tablero.
    """
    df = elisa.copy()
    df["is_detectado"] = df["is_detectado"].astype(int)
    df["excede_umbral"] = df["excede_umbral"].astype(int)

    ancho = df.pivot_table(
        index="lote_id",
        columns="agroquimico",
        values=["ppm_detectado", "excede_umbral", "is_detectado"],
        aggfunc="first",
    )
    ancho.columns = [
        f"{metrica}_{agro}".lower().replace(" ", "_") for metrica, agro in ancho.columns
    ]
    ancho = ancho.reset_index()

    cols_excede = [c for c in ancho.columns if c.startswith("excede_umbral_")]
    cols_detec = [c for c in ancho.columns if c.startswith("is_detectado_")]

    ancho["n_kits_excedidos"] = ancho[cols_excede].sum(axis=1).astype(int)
    ancho["n_kits_detectados"] = ancho[cols_detec].sum(axis=1).astype(int)

    # Etiqueta objetivo. Un lote esta contaminado si cualquier kit del panel
    # supera su criterio, exactamente la regla que aplica el tablero.
    ancho["lote_contaminado"] = (ancho["n_kits_excedidos"] > 0).astype(int)

    return ancho


# ===========================================================================
# 6. Escritura
# ===========================================================================
def escribir(df: pd.DataFrame, ruta: Path, etiqueta: str) -> None:
    ruta.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(ruta, index=False)
    print(f"  {etiqueta:38s} {len(df):>8,} filas  {ruta.relative_to(RAIZ)}")


def diagnostico_canales(elisa: pd.DataFrame) -> None:
    """
    Reparto de los hallazgos entre las dos vias de contaminacion.

    Si una de las dos concentra casi todo, el modelo aprende solo esa y la
    mitad de la arquitectura queda sin evidencia. Sirve para calibrar el
    generador, no forma parte de los datos que se entregan.
    """
    hallazgos = elisa[elisa["excede_umbral"]]
    if hallazgos.empty:
        return
    total = len(hallazgos)
    deriva = int((hallazgos["aporte_deriva"] > hallazgos["aporte_operativo"]).sum())
    print()
    print("Reparto de hallazgos por via de contaminacion")
    print(f"  dominados por deriva        {deriva:>8,}  {deriva / total:>7.1%}")
    print(
        f"  dominados por via operativa {total - deriva:>8,} "
        f" {(total - deriva) / total:>7.1%}"
    )
    print(
        "  ppm mediano deriva "
        f"{hallazgos['aporte_deriva'].median():.4f}   "
        f"operativo {hallazgos['aporte_operativo'].median():.4f}"
    )


def main() -> None:
    n_fincas = int(sys.argv[1]) if len(sys.argv) > 1 else 120
    n_lotes = int(sys.argv[2]) if len(sys.argv) > 2 else 4200
    semilla = int(sys.argv[3]) if len(sys.argv) > 3 else 20260829

    rng = np.random.default_rng(semilla)
    fechas = pd.date_range("2025-01-01", "2026-08-31", freq="D")

    print("CafeTrace. Generacion de data sintetica fisicamente informada")
    print(f"  fincas {n_fincas}   lotes {n_lotes}   dias {len(fechas)}   semilla {semilla}")
    print()

    print("Capa cruda")
    fincas = generar_fincas(rng, n_fincas)
    meteo = generar_meteo(rng, fincas, fechas)
    lotes = generar_lotes(rng, fincas, fechas, n_lotes)
    campo = generar_registros_campo(rng, lotes, fincas)

    meteo_win = ventana_meteo(meteo, dias=15)
    elisa = simular_elisa(rng, lotes, fincas, campo, meteo_win)

    escribir(fincas, RAW / "apis" / "gis_fincas.csv", "GIS de fincas")
    escribir(meteo, RAW / "apis" / "meteo_diaria.csv", "Meteorologia diaria")
    escribir(lotes, RAW / "app" / "lotes.csv", "Lotes cosechados")
    escribir(campo, RAW / "app" / "registros_campo.csv", "Cuaderno de campo digital")
    escribir(
        elisa.drop(columns=["aporte_deriva", "aporte_operativo"]),
        RAW / "elisa" / "resultados_elisa.csv",
        "Resultados de laboratorio",
    )

    print()
    print("Capa procesada")
    escribir(limpiar_fincas(fincas), CLEAN / "apis" / "gis_fincas.csv", "GIS de fincas")
    escribir(limpiar_meteo(meteo_win), CLEAN / "apis" / "meteo_ventana.csv", "Meteorologia de ventana")
    escribir(lotes, CLEAN / "app" / "lotes.csv", "Lotes cosechados")
    escribir(limpiar_campo(campo), CLEAN / "app" / "registros_campo.csv", "Cuaderno de campo digital")
    escribir(limpiar_elisa(elisa), CLEAN / "elisa" / "elisa_lote.csv", "ELISA por lote")
    escribir(
        elisa.drop(
            columns=["ppm_simulado_interno", "aporte_deriva", "aporte_operativo"]
        ),
        CLEAN / "elisa" / "elisa_muestra.csv",
        "ELISA por muestra",
    )

    # Diccionario del panel. Lo consumen el notebook, el formulario de
    # captura y el servidor de ingesta, para que nadie duplique umbrales.
    panel_path = RAIZ / "data" / "panel_agroquimicos.json"
    panel_path.write_text(json.dumps(PANEL, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\n  panel de agroquimicos                     {panel_path.relative_to(RAIZ)}")

    diagnostico_canales(elisa)

    tabla = limpiar_elisa(elisa)
    tasa = tabla["lote_contaminado"].mean()
    print()
    print("Resumen del target")
    print(f"  lotes                       {len(tabla):>8,}")
    print(f"  lotes contaminados          {int(tabla['lote_contaminado'].sum()):>8,}")
    print(f"  tasa de contaminacion       {tasa:>8.2%}")
    for agro in PANEL:
        col = f"excede_umbral_{agro['agroquimico'].lower()}"
        if col in tabla.columns:
            print(f"    {agro['agroquimico']:14s}          {tabla[col].mean():>8.2%}")

    del meteo, elisa
    gc.collect()


if __name__ == "__main__":
    main()
