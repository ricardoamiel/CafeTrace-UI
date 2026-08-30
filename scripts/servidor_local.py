"""
CafeTrace. Servidor local de ingesta.

Resuelve el hueco que tenia el MVP: el formulario del tablero guardaba en
localStorage del navegador y el CSV nunca se actualizaba. Ahora las altas
viajan a este servidor y se escriben en disco, de modo que el dato queda
donde el resto del pipeline lo puede leer.

En la arquitectura objetivo este rol lo cumple un API Gateway con funciones
sin servidor escribiendo sobre un data lake. Para el MVP todo es local: un
solo proceso de biblioteca estandar, sin dependencias, sin nube, sin base
de datos.

Sirve dos cosas a la vez:

    Archivos estaticos      el tablero en index.html y el formulario de
                            captura en captura/index.html
    API de ingesta          escritura transaccional sobre los CSV

Rutas de la API:

    GET  /api/estado        salud del servidor y conteo de filas por CSV
    GET  /api/catalogo      listas para poblar los desplegables del formulario
    POST /api/registro      alta de productor, lote o resultado de kit
    POST /api/campo         alta del cuaderno de campo digital

El servidor es la autoridad sobre la coherencia del dato: deriva el sello
de tiempo, el kit y el tipo de lectura desde el panel, y recalcula el
resultado contra el umbral en vez de confiar en lo que teclee el operador.

Uso:
    python3 scripts/servidor_local.py
    python3 scripts/servidor_local.py 9000
"""

from __future__ import annotations

import csv
import json
import re
import sys
import threading
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
DATA = RAIZ / "data"

PUERTO_POR_DEFECTO = 8777

# Un unico candado para todas las escrituras. El volumen de un centro de
# acopio no justifica nada mas fino, y garantiza que dos tecnicos que
# guardan a la vez no se pisen la fila.
CANDADO = threading.Lock()


# ---------------------------------------------------------------------------
# Esquemas. Definen que archivo toca cada entidad y en que orden van las
# columnas. El orden lo manda siempre la cabecera real del CSV en disco.
# ---------------------------------------------------------------------------
ENTIDADES = {
    "productores": {
        "archivo": DATA / "productores.csv",
        "clave": "ID_Productor",
        "prefijo": "P",
        "obligatorios": [
            "Nombre",
            "Finca",
            "Coordenadas_Lat",
            "Coordenadas_Lon",
            "Certificacion_Declarada",
            "Proximidad_Finca_Convencional",
            "Empresa_Exportadora",
        ],
    },
    "lotes": {
        "archivo": DATA / "lotes_cafe.csv",
        "clave": "ID_Lote",
        "prefijo": "L",
        "obligatorios": [
            "ID_Productor",
            "Peso_Quintales",
            "Destino",
            "Estado_Transito",
            "Estado_Seguridad",
        ],
    },
    "tests": {
        "archivo": DATA / "test_elisa.csv",
        "clave": "ID_Test",
        "prefijo": "T",
        "obligatorios": ["ID_Productor", "ID_Lote", "Agroquimico", "Operador"],
    },
}

CAMPO_ARCHIVO = DATA / "raw" / "app" / "capturas_formulario.csv"
CAMPO_COLUMNAS = [
    "registro_id",
    "lote_id",
    "finca_id",
    "fecha_registro",
    "tecnico_id",
    "vecino_fumigo_reciente",
    "dias_desde_fumigacion_vecina",
    "despulpadora_compartida",
    "sacos_reutilizados",
    "secado_patio_compartido",
    "transporte_compartido",
    "herramientas_compartidas_flag",
    "lavado_equipo_flag",
    "capacitacion_bpa_flag",
    "lat_gps",
    "lon_gps",
    "origen_captura",
]


def cargar_panel() -> list[dict]:
    """
    Panel de agroquimicos. Se lee del diccionario que emite el generador de
    data sintetica para que servidor, formulario y notebook compartan una
    sola definicion de umbrales.
    """
    ruta = DATA / "panel_agroquimicos.json"
    if ruta.exists():
        return json.loads(ruta.read_text(encoding="utf-8"))
    # Respaldo minimo si aun no se corrio el generador.
    return [
        {"agroquimico": "Glifosato", "kit": "ELISA_GLY_96",
         "tipo_lectura": "Cuantitativo", "umbral_ppm": 0.10},
        {"agroquimico": "Clorpirifos", "kit": "ELISA_CPF_96",
         "tipo_lectura": "Cuantitativo", "umbral_ppm": 0.05},
        {"agroquimico": "Cipermetrina", "kit": "ELISA_PYR_48",
         "tipo_lectura": "Cualitativo", "umbral_ppm": None},
        {"agroquimico": "Carbendazim", "kit": "ELISA_CBZ_96",
         "tipo_lectura": "Cuantitativo", "umbral_ppm": 0.10},
    ]


PANEL = cargar_panel()
PANEL_POR_NOMBRE = {a["agroquimico"]: a for a in PANEL}


# ---------------------------------------------------------------------------
# Utilidades de CSV
# ---------------------------------------------------------------------------
def leer_csv(ruta: Path) -> tuple[list[str], list[dict]]:
    if not ruta.exists():
        return [], []
    with ruta.open(newline="", encoding="utf-8") as fh:
        lector = csv.DictReader(fh)
        return list(lector.fieldnames or []), list(lector)


def siguiente_id(filas: list[dict], clave: str, prefijo: str) -> str:
    """
    Siguiente identificador correlativo. Lee el maximo numerico presente en
    el archivo en vez de contar filas, para que borrar una fila no genere
    despues un identificador repetido.
    """
    maximo = 0
    patron = re.compile(rf"^{re.escape(prefijo)}0*(\d+)$", re.IGNORECASE)
    for fila in filas:
        m = patron.match(str(fila.get(clave, "")).strip())
        if m:
            maximo = max(maximo, int(m.group(1)))
    ancho = 3 if prefijo in ("P", "L", "T") else 4
    return f"{prefijo}{maximo + 1:0{ancho}d}"


def anexar_fila(ruta: Path, columnas: list[str], registro: dict) -> None:
    """
    Anexa una fila respetando el orden de la cabecera existente. Si el
    archivo no existe todavia, lo crea con la cabecera indicada.
    """
    ruta.parent.mkdir(parents=True, exist_ok=True)
    existe = ruta.exists() and ruta.stat().st_size > 0

    with ruta.open("a", newline="", encoding="utf-8") as fh:
        escritor = csv.writer(fh, lineterminator="\n")
        if not existe:
            escritor.writerow(columnas)
        escritor.writerow([str(registro.get(col, "")) for col in columnas])


# ---------------------------------------------------------------------------
# Reglas de coherencia. El servidor es la autoridad, no el navegador.
# ---------------------------------------------------------------------------
def normalizar_test(datos: dict) -> tuple[dict, str | None]:
    """
    Completa y valida un resultado de kit.

    El tipo de lectura lo impone el kit, no el operador: un kit cualitativo
    no puede reportar ppm y uno cuantitativo no puede reportar solo
    presencia. El resultado se deriva del umbral.
    """
    nombre = str(datos.get("Agroquimico", "")).strip()
    definicion = PANEL_POR_NOMBRE.get(nombre)
    if definicion is None:
        return {}, f"Agroquimico fuera del panel: {nombre}"

    datos["Kit"] = definicion["kit"]
    datos["Tipo_Lectura"] = definicion["tipo_lectura"]

    if definicion["tipo_lectura"] == "Cuantitativo":
        crudo = str(datos.get("Valor_ppm", "")).strip()
        if crudo == "":
            return {}, f"El kit de {nombre} exige una concentracion en ppm"
        try:
            valor = float(crudo)
        except ValueError:
            return {}, f"Concentracion no numerica: {crudo}"
        if valor < 0:
            return {}, "La concentracion no puede ser negativa"
        datos["Valor_ppm"] = f"{valor:.4f}".rstrip("0").rstrip(".")
        umbral = definicion.get("umbral_ppm")
        datos["Resultado"] = (
            "Alerta_Contaminacion" if umbral is not None and valor > umbral else "Aprobado"
        )
    else:
        lectura = str(datos.get("Resultado", "")).strip()
        if lectura not in ("Detectado", "No_Detectado"):
            return {}, f"El kit de {nombre} exige lectura Detectado o No_Detectado"
        datos["Valor_ppm"] = ""
        datos["Resultado"] = lectura

    datos["Timestamp"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return datos, None


def validar(entidad: str, datos: dict) -> str | None:
    esquema = ENTIDADES[entidad]
    faltantes = [c for c in esquema["obligatorios"] if not str(datos.get(c, "")).strip()]
    if faltantes:
        return "Faltan campos obligatorios: " + ", ".join(faltantes)
    return validar_referencias(entidad, datos)


def validar_referencias(entidad: str, datos: dict) -> str | None:
    """
    Integridad referencial. El motor de reglas del tablero descarta en
    silencio los lotes cuyo productor no existe, asi que una fila huerfana
    se traduce en un lote que desaparece del mapa sin que nadie se entere.
    Es mejor rechazar el alta aqui que perder el dato despues.
    """
    if entidad == "productores":
        return None

    _, productores = leer_csv(ENTIDADES["productores"]["archivo"])
    ids_productor = {str(p.get("ID_Productor", "")).strip() for p in productores}

    pid = str(datos.get("ID_Productor", "")).strip()
    if pid and pid not in ids_productor:
        return f"El productor {pid} no existe. Registralo antes que su lote."

    if entidad == "tests":
        _, lotes = leer_csv(ENTIDADES["lotes"]["archivo"])
        por_lote = {
            str(l.get("ID_Lote", "")).strip(): str(l.get("ID_Productor", "")).strip()
            for l in lotes
        }
        lid = str(datos.get("ID_Lote", "")).strip()
        if lid not in por_lote:
            return f"El lote {lid} no existe. Registralo antes que su resultado."
        if pid and por_lote[lid] != pid:
            return (
                f"El lote {lid} pertenece a {por_lote[lid]} y el alta declara {pid}"
            )

    return None


def alta_registro(entidad: str, datos: dict) -> dict:
    """
    Escribe una fila nueva en el CSV de la entidad y devuelve el resultado.
    Toda la operacion ocurre bajo candado para que dos altas simultaneas no
    reciban el mismo identificador.
    """
    if entidad not in ENTIDADES:
        raise ValueError(f"Entidad desconocida: {entidad}")

    esquema = ENTIDADES[entidad]
    datos = {k: ("" if v is None else str(v).strip()) for k, v in datos.items()}

    error = validar(entidad, datos)
    if error:
        raise ValueError(error)

    if entidad == "tests":
        datos, error = normalizar_test(datos)
        if error:
            raise ValueError(error)

    if entidad == "lotes" and not datos.get("Riesgo_Calculado"):
        # El motor de reglas del tablero recalcula el riesgo. Lo que entra
        # por formulario queda marcado como pendiente de calculo.
        datos["Riesgo_Calculado"] = "Por_Calcular"

    with CANDADO:
        columnas, filas = leer_csv(esquema["archivo"])
        if not columnas:
            raise ValueError(f"No existe o esta vacio {esquema['archivo'].name}")

        clave = esquema["clave"]
        if not datos.get(clave):
            datos[clave] = siguiente_id(filas, clave, esquema["prefijo"])
        else:
            existentes = {str(f.get(clave, "")).strip() for f in filas}
            if datos[clave] in existentes:
                raise ValueError(f"El identificador {datos[clave]} ya existe")

        desconocidas = [c for c in datos if c not in columnas]
        anexar_fila(esquema["archivo"], columnas, datos)
        total = len(filas) + 1

    return {
        "ok": True,
        "entidad": entidad,
        "id": datos[clave],
        "archivo": str(esquema["archivo"].relative_to(RAIZ)),
        "filas": total,
        "ignoradas": desconocidas,
        "fila": {c: datos.get(c, "") for c in columnas},
    }


def alta_campo(datos: dict) -> dict:
    """
    Registro del cuaderno de campo digital. Alimenta la capa cruda que
    consume el pipeline de aprendizaje, no el tablero.
    """
    datos = {k: ("" if v is None else v) for k, v in datos.items()}

    if not str(datos.get("lote_id", "")).strip():
        raise ValueError("El registro de campo exige un lote")

    with CANDADO:
        _, filas = leer_csv(CAMPO_ARCHIVO)
        datos["registro_id"] = datos.get("registro_id") or f"CF{len(filas) + 1:07d}"
        datos.setdefault(
            "fecha_registro", datetime.now(timezone.utc).date().isoformat()
        )
        datos.setdefault("origen_captura", "formulario_campo")

        for flag in [
            "despulpadora_compartida",
            "sacos_reutilizados",
            "secado_patio_compartido",
            "transporte_compartido",
            "lavado_equipo_flag",
            "capacitacion_bpa_flag",
        ]:
            datos[flag] = int(bool(datos.get(flag)))

        datos["herramientas_compartidas_flag"] = int(
            bool(
                datos["despulpadora_compartida"]
                or datos["sacos_reutilizados"]
                or datos["secado_patio_compartido"]
                or datos["transporte_compartido"]
            )
        )

        if not str(datos.get("dias_desde_fumigacion_vecina", "")).strip():
            datos["dias_desde_fumigacion_vecina"] = -1

        anexar_fila(CAMPO_ARCHIVO, CAMPO_COLUMNAS, datos)
        total = len(filas) + 1

    return {
        "ok": True,
        "id": datos["registro_id"],
        "archivo": str(CAMPO_ARCHIVO.relative_to(RAIZ)),
        "filas": total,
    }


def catalogo() -> dict:
    """Listas vigentes para poblar los desplegables del formulario."""
    _, productores = leer_csv(ENTIDADES["productores"]["archivo"])
    _, lotes = leer_csv(ENTIDADES["lotes"]["archivo"])

    por_lote = {
        l["ID_Lote"]: l.get("ID_Productor", "")
        for l in lotes
        if l.get("ID_Lote")
    }
    nombre_finca = {
        p["ID_Productor"]: p.get("Finca", "")
        for p in productores
        if p.get("ID_Productor")
    }

    return {
        "panel": [
            {
                "agroquimico": a["agroquimico"],
                "kit": a["kit"],
                "tipo_lectura": a["tipo_lectura"],
                "umbral_ppm": a.get("umbral_ppm"),
                "clase": a.get("clase", ""),
            }
            for a in PANEL
        ],
        "lotes": [
            {
                "id_lote": lid,
                "id_productor": pid,
                "finca": nombre_finca.get(pid, ""),
            }
            for lid, pid in sorted(por_lote.items())
        ],
        "productores": sorted(nombre_finca.keys()),
        "empresas": sorted(
            {p.get("Empresa_Exportadora", "") for p in productores} - {""}
        ),
        "destinos": sorted({l.get("Destino", "") for l in lotes} - {""}),
        "operadores": sorted(
            {
                t.get("Operador", "")
                for t in leer_csv(ENTIDADES["tests"]["archivo"])[1]
            }
            - {""}
        ),
    }


def estado() -> dict:
    conteos = {}
    for nombre, esquema in ENTIDADES.items():
        _, filas = leer_csv(esquema["archivo"])
        conteos[nombre] = len(filas)
    _, campo = leer_csv(CAMPO_ARCHIVO)
    conteos["campo"] = len(campo)
    return {
        "ok": True,
        "servicio": "CafeTrace ingesta local",
        "version": "1.0.0",
        "escribe_csv": True,
        "raiz": str(RAIZ),
        "conteos": conteos,
    }


# ---------------------------------------------------------------------------
# Servidor
# ---------------------------------------------------------------------------
class Manejador(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(RAIZ), **kwargs)

    def log_message(self, formato, *args):
        # Silencia el log de estaticos y deja solo lo que importa en consola.
        if "/api/" in str(args[0] if args else ""):
            super().log_message(formato, *args)

    def _json(self, codigo: int, cuerpo: dict) -> None:
        datos = json.dumps(cuerpo, ensure_ascii=False).encode("utf-8")
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(datos)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(datos)

    def end_headers(self):
        # Los CSV cambian en cada alta. Sin esto el navegador sirve la copia
        # cacheada y el tablero recarga sin ver la fila recien escrita.
        if self.path.split("?")[0].endswith((".csv", ".json")):
            self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def do_GET(self):  # noqa: N802
        if self.path.split("?")[0] == "/api/estado":
            return self._json(200, estado())
        if self.path.split("?")[0] == "/api/catalogo":
            return self._json(200, catalogo())
        return super().do_GET()

    def do_POST(self):  # noqa: N802
        ruta = self.path.split("?")[0]
        if ruta not in ("/api/registro", "/api/campo"):
            return self._json(404, {"ok": False, "error": "Ruta no encontrada"})

        try:
            largo = int(self.headers.get("Content-Length", 0))
            if largo <= 0 or largo > 1_000_000:
                raise ValueError("Cuerpo vacio o demasiado grande")
            cuerpo = json.loads(self.rfile.read(largo).decode("utf-8"))
        except Exception as exc:
            return self._json(400, {"ok": False, "error": f"JSON invalido: {exc}"})

        try:
            if ruta == "/api/registro":
                resultado = alta_registro(
                    str(cuerpo.get("entidad", "")), dict(cuerpo.get("datos", {}))
                )
                print(
                    f"  alta {resultado['entidad']:12s} {resultado['id']:8s} "
                    f"total {resultado['filas']:4d}  {resultado['archivo']}"
                )
            else:
                resultado = alta_campo(dict(cuerpo.get("datos", cuerpo)))
                print(
                    f"  alta campo        {resultado['id']:8s} "
                    f"total {resultado['filas']:4d}  {resultado['archivo']}"
                )
            return self._json(201, resultado)
        except ValueError as exc:
            return self._json(422, {"ok": False, "error": str(exc)})
        except Exception as exc:  # pragma: no cover
            return self._json(500, {"ok": False, "error": f"Error interno: {exc}"})


def main() -> None:
    puerto = int(sys.argv[1]) if len(sys.argv) > 1 else PUERTO_POR_DEFECTO

    servidor = ThreadingHTTPServer(("127.0.0.1", puerto), Manejador)
    base = f"http://127.0.0.1:{puerto}"

    print("CafeTrace. Servidor local de ingesta")
    print(f"  raiz              {RAIZ}")
    print(f"  tablero           {base}/index.html")
    print(f"  formulario campo  {base}/captura/index.html")
    print(f"  estado            {base}/api/estado")
    print()
    print("  Las altas se escriben en los CSV de data. Ctrl C para detener.")
    print()

    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        print("\n  servidor detenido")
    finally:
        servidor.server_close()


if __name__ == "__main__":
    main()
