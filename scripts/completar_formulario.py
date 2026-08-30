"""
CafeTrace. Llenado del formulario de captura.

El mismo formulario se puede completar de dos maneras, y ambas terminan en
el mismo sitio: el endpoint de ingesta que escribe los CSV.

    automatico   La plataforma consume una cola de eventos ya ingeridos y
                 autocompleta el formulario sin que nadie teclee. Es el modo
                 que corresponde a la arquitectura orientada a eventos: el
                 laboratorio publica el resultado leyendo el codigo QR de la
                 muestra y el formulario se llena solo.

    manual       El encargado de campo responde por consola. Es el camino de
                 respaldo cuando el laboratorio entrega en papel o cuando hay
                 que corregir a mano.

Sobre la cola. En la arquitectura objetivo el transporte es Kafka: el LIMS y
la aplicacion movil publican en un topico y la plataforma consume con un
grupo de consumidores que confirma su avance. En este MVP todo es local, asi
que el topico es un archivo de una linea por evento y el avance del grupo es
un archivo de posicion. La interfaz es la misma, de modo que cambiar a un
broker real significa sustituir una clase, no reescribir el flujo. Si la
biblioteca de Kafka esta instalada y se indica un broker, se usa el broker.

Uso:
    python3 scripts/completar_formulario.py producir 40
    python3 scripts/completar_formulario.py automatico
    python3 scripts/completar_formulario.py automatico 15
    python3 scripts/completar_formulario.py manual
    python3 scripts/completar_formulario.py estado
"""

from __future__ import annotations

import json
import random
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
COLA_DIR = RAIZ / "data" / "cola"
TOPICO = COLA_DIR / "eventos_captura.jsonl"
POSICION = COLA_DIR / "posicion_grupo_captura.json"

GRUPO = "cafetrace.captura"
SERVIDOR = "http://127.0.0.1:8777"


# ===========================================================================
# Transporte hacia el formulario
# ===========================================================================
def llamar(ruta: str, cuerpo: dict | None = None, metodo: str = "GET") -> dict:
    datos = None
    cabeceras = {}
    if cuerpo is not None:
        datos = json.dumps(cuerpo).encode("utf-8")
        cabeceras["Content-Type"] = "application/json"

    peticion = urllib.request.Request(
        SERVIDOR + ruta, data=datos, headers=cabeceras, method=metodo
    )
    try:
        with urllib.request.urlopen(peticion, timeout=10) as respuesta:
            return json.loads(respuesta.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detalle = exc.read().decode("utf-8", errors="replace")
        try:
            return json.loads(detalle)
        except json.JSONDecodeError:
            return {"ok": False, "error": f"HTTP {exc.code}: {detalle[:200]}"}
    except urllib.error.URLError as exc:
        raise SystemExit(
            f"\nNo hay servidor de ingesta en {SERVIDOR} ({exc.reason}).\n"
            f"Levantalo primero con:  python3 scripts/servidor_local.py\n"
        )


def enviar_formulario(payload: dict, campo: dict | None) -> dict:
    """
    Envia el formulario completo. El resultado del kit es lo que el tablero
    necesita; el cuaderno de campo es complementario y su fallo no invalida
    el resultado ya escrito.
    """
    datos = {
        "ID_Productor": payload["id_productor"],
        "ID_Lote": payload["id_lote"],
        "Agroquimico": payload["agroquimico"],
        "Operador": payload["operador"],
    }
    if payload.get("valor_ppm") is not None:
        datos["Valor_ppm"] = payload["valor_ppm"]
    if payload.get("lectura"):
        datos["Resultado"] = payload["lectura"]

    respuesta = llamar("/api/registro", {"entidad": "tests", "datos": datos}, "POST")

    if respuesta.get("ok") and campo:
        campo.setdefault("lote_id", payload["id_lote"])
        campo.setdefault("finca_id", payload["id_productor"])
        campo.setdefault("tecnico_id", payload["operador"])
        eco = llamar("/api/campo", {"datos": campo}, "POST")
        respuesta["campo"] = eco.get("id") if eco.get("ok") else eco.get("error")

    return respuesta


# ===========================================================================
# Cola de eventos
# ===========================================================================
class ColaArchivo:
    """
    Topico local de una linea por evento, con posicion confirmada aparte.

    Reproduce las dos propiedades que importan de un topico de Kafka para
    este caso: los eventos se leen en orden y la posicion solo avanza cuando
    el consumidor confirma. Si el proceso muere a la mitad, al reiniciar
    retoma en el evento que no alcanzo a procesar y no se pierde ninguno.
    """

    nombre = "archivo local"

    def __init__(self, topico: Path = TOPICO, posicion: Path = POSICION):
        self.topico = topico
        self.posicion = posicion
        self.topico.parent.mkdir(parents=True, exist_ok=True)

    def publicar(self, eventos: list[dict]) -> int:
        with self.topico.open("a", encoding="utf-8") as fh:
            for evento in eventos:
                fh.write(json.dumps(evento, ensure_ascii=False) + "\n")
        return len(eventos)

    def _todos(self) -> list[dict]:
        if not self.topico.exists():
            return []
        with self.topico.open(encoding="utf-8") as fh:
            return [json.loads(linea) for linea in fh if linea.strip()]

    def leer_posicion(self) -> int:
        if not self.posicion.exists():
            return 0
        try:
            return int(json.loads(self.posicion.read_text(encoding="utf-8"))["posicion"])
        except (json.JSONDecodeError, KeyError, ValueError):
            return 0

    def confirmar(self, posicion: int) -> None:
        self.posicion.write_text(
            json.dumps(
                {
                    "grupo": GRUPO,
                    "posicion": posicion,
                    "confirmado_en": datetime.now(timezone.utc).isoformat(
                        timespec="seconds"
                    ),
                },
                indent=2,
            ),
            encoding="utf-8",
        )

    def consumir(self, maximo: int | None = None):
        eventos = self._todos()
        inicio = self.leer_posicion()
        pendientes = eventos[inicio:]
        if maximo is not None:
            pendientes = pendientes[:maximo]
        for desplazamiento, evento in enumerate(pendientes, start=inicio):
            yield desplazamiento, evento

    def pendientes(self) -> int:
        return max(0, len(self._todos()) - self.leer_posicion())


class ColaKafka:
    """
    Consumidor real. Se activa solo si la biblioteca esta instalada y se
    indica un broker. La firma es la misma que la del topico local, de modo
    que el resto del script no distingue entre uno y otro.
    """

    nombre = "kafka"

    def __init__(self, broker: str, topico: str = "cafetrace.captura"):
        from kafka import KafkaConsumer, KafkaProducer  # importado bajo demanda

        self.topico = topico
        self._KafkaProducer = KafkaProducer
        self._broker = broker
        self.consumidor = KafkaConsumer(
            topico,
            bootstrap_servers=broker,
            group_id=GRUPO,
            enable_auto_commit=False,
            auto_offset_reset="earliest",
            value_deserializer=lambda v: json.loads(v.decode("utf-8")),
            consumer_timeout_ms=8000,
        )

    def publicar(self, eventos: list[dict]) -> int:
        productor = self._KafkaProducer(
            bootstrap_servers=self._broker,
            value_serializer=lambda v: json.dumps(v).encode("utf-8"),
        )
        for evento in eventos:
            productor.send(self.topico, evento)
        productor.flush()
        return len(eventos)

    def consumir(self, maximo: int | None = None):
        leidos = 0
        for mensaje in self.consumidor:
            yield mensaje.offset, mensaje.value
            leidos += 1
            if maximo is not None and leidos >= maximo:
                break

    def confirmar(self, posicion: int) -> None:
        self.consumidor.commit()

    def pendientes(self) -> int:
        return -1  # el broker lleva la cuenta, no el cliente


def abrir_cola(broker: str | None) -> ColaArchivo | ColaKafka:
    if broker:
        try:
            return ColaKafka(broker)
        except ImportError:
            print("  aviso: la biblioteca de Kafka no esta instalada, se usa el topico local")
        except Exception as exc:
            print(f"  aviso: no se pudo conectar al broker ({exc}), se usa el topico local")
    return ColaArchivo()


# ===========================================================================
# Productor de eventos. Simula lo que publicarian el laboratorio y la
# aplicacion movil sobre lotes que existen de verdad en el catalogo.
# ===========================================================================
def producir(cantidad: int, semilla: int = 20260829) -> None:
    rng = random.Random(semilla)
    catalogo = llamar("/api/catalogo")

    lotes = catalogo["lotes"]
    panel = catalogo["panel"]
    operadores = catalogo["operadores"] or ["Ricardo", "Juan", "Ana"]

    if not lotes:
        raise SystemExit("El catalogo no tiene lotes. Registra lotes antes de producir eventos.")

    eventos = []
    for n in range(cantidad):
        lote = rng.choice(lotes)
        agro = rng.choice(panel)

        # Una de cada seis muestras trae residuo sobre criterio. Es la tasa
        # que hace util la alerta sin volverla ruido.
        contaminada = rng.random() < 0.17

        if agro["tipo_lectura"] == "Cuantitativo":
            umbral = agro["umbral_ppm"] or 0.10
            if contaminada:
                valor = round(rng.uniform(umbral * 1.05, umbral * 4.0), 4)
            else:
                valor = round(rng.uniform(0.0, umbral * 0.75), 4)
            lectura = None
        else:
            valor = None
            lectura = "Detectado" if contaminada else "No_Detectado"

        eventos.append(
            {
                "evento_id": f"EV{n + 1:06d}",
                "tipo": "resultado_elisa",
                "publicado_en": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "origen": rng.choice(["lims_laboratorio", "app_movil_campo"]),
                "payload": {
                    "id_lote": lote["id_lote"],
                    "id_productor": lote["id_productor"],
                    "agroquimico": agro["agroquimico"],
                    "valor_ppm": valor,
                    "lectura": lectura,
                    "operador": rng.choice(operadores),
                },
                "campo": {
                    "vecino_fumigo_reciente": rng.choice(["Si", "No", "No_se_sabe"]),
                    "dias_desde_fumigacion_vecina": rng.randint(1, 40),
                    "despulpadora_compartida": rng.random() < 0.35,
                    "sacos_reutilizados": rng.random() < 0.30,
                    "secado_patio_compartido": rng.random() < 0.32,
                    "transporte_compartido": rng.random() < 0.38,
                    "lavado_equipo_flag": rng.random() < 0.62,
                    "capacitacion_bpa_flag": rng.random() < 0.55,
                    "origen_captura": "cola_kafka",
                },
            }
        )

    cola = ColaArchivo()
    cola.publicar(eventos)
    print(f"Publicados {len(eventos)} eventos en {TOPICO.relative_to(RAIZ)}")
    print(f"Pendientes de consumir: {cola.pendientes()}")


# ===========================================================================
# Modo automatico
# ===========================================================================
def modo_automatico(maximo: int | None, broker: str | None) -> None:
    cola = abrir_cola(broker)

    print("CafeTrace. Llenado automatico del formulario")
    print(f"  cola      {cola.nombre}")
    print(f"  destino   {SERVIDOR}/api/registro")
    if isinstance(cola, ColaArchivo):
        print(f"  pendientes {cola.pendientes()}")
    print()

    escritos = 0
    rechazados = 0
    ultima_posicion = None

    for desplazamiento, evento in cola.consumir(maximo):
        payload = evento.get("payload", {})
        campo = evento.get("campo")

        respuesta = enviar_formulario(payload, campo)

        if respuesta.get("ok"):
            escritos += 1
            lectura = (
                f"{payload['valor_ppm']} ppm"
                if payload.get("valor_ppm") is not None
                else str(payload.get("lectura", ""))
            )
            # Un kit cuantitativo conforme dice Aprobado y uno cualitativo
            # dice No_Detectado. Ambos son ausencia de hallazgo.
            conforme = respuesta["fila"]["Resultado"] in ("Aprobado", "No_Detectado")
            marca = "ok    " if conforme else "ALERTA"
            print(
                f"  {evento['evento_id']}  {payload['id_lote']:6s} "
                f"{payload['agroquimico']:13s} {lectura:>16s}  {marca}  "
                f"-> {respuesta['id']}"
            )
        else:
            rechazados += 1
            print(f"  {evento['evento_id']}  rechazado: {respuesta.get('error')}")

        # La posicion avanza igual ante un rechazo de validacion: reintentar
        # un evento mal formado en bucle bloquearia la cola para siempre.
        ultima_posicion = desplazamiento + 1

    if ultima_posicion is not None:
        cola.confirmar(ultima_posicion)

    print()
    print(f"  escritos en CSV   {escritos}")
    print(f"  rechazados        {rechazados}")
    if isinstance(cola, ColaArchivo):
        print(f"  quedan en cola    {cola.pendientes()}")


# ===========================================================================
# Modo manual
# ===========================================================================
def preguntar(etiqueta: str, opciones: list[str] | None = None,
              obligatorio: bool = True, por_defecto: str = "") -> str:
    """Pregunta por consola. Con opciones se responde por numero o por texto."""
    while True:
        if opciones:
            print(f"\n{etiqueta}")
            for i, opcion in enumerate(opciones, start=1):
                print(f"   {i:2d}. {opcion}")
            cruda = input("   numero u opcion: ").strip()
            if not cruda and por_defecto:
                return por_defecto
            if cruda.isdigit() and 1 <= int(cruda) <= len(opciones):
                return opciones[int(cruda) - 1]
            if cruda in opciones:
                return cruda
            print("   opcion no valida")
            continue

        sufijo = f" [{por_defecto}]" if por_defecto else ""
        cruda = input(f"{etiqueta}{sufijo}: ").strip()
        if not cruda and por_defecto:
            return por_defecto
        if cruda or not obligatorio:
            return cruda
        print("   este dato es obligatorio")


def preguntar_si_no(etiqueta: str, por_defecto: bool = False) -> bool:
    marca = "S/n" if por_defecto else "s/N"
    cruda = input(f"{etiqueta} [{marca}]: ").strip().lower()
    if not cruda:
        return por_defecto
    return cruda.startswith("s")


def modo_manual() -> None:
    catalogo = llamar("/api/catalogo")
    lotes = catalogo["lotes"]
    panel = catalogo["panel"]

    print("CafeTrace. Llenado manual del formulario")
    print(f"  destino   {SERVIDOR}/api/registro")
    print("  Enter deja el valor por defecto. Ctrl C cancela.")

    if not lotes:
        raise SystemExit("El catalogo no tiene lotes.")

    etiquetas = [f"{l['id_lote']}  {l['finca']}" for l in lotes]
    elegido = preguntar("Lote", etiquetas)
    lote = lotes[etiquetas.index(elegido)]

    nombres = [a["agroquimico"] for a in panel]
    nombre_agro = preguntar("Agroquimico del kit", nombres)
    agro = panel[nombres.index(nombre_agro)]

    payload = {
        "id_lote": lote["id_lote"],
        "id_productor": lote["id_productor"],
        "agroquimico": agro["agroquimico"],
        "valor_ppm": None,
        "lectura": None,
    }

    if agro["tipo_lectura"] == "Cuantitativo":
        umbral = agro["umbral_ppm"]
        print(f"\n   kit {agro['kit']} cuantitativo, umbral {umbral} ppm")
        while True:
            crudo = preguntar("Concentracion en ppm")
            try:
                valor = float(crudo)
                if valor < 0:
                    print("   no puede ser negativa")
                    continue
                payload["valor_ppm"] = valor
                break
            except ValueError:
                print("   escribe un numero, por ejemplo 0.045")
    else:
        print(f"\n   kit {agro['kit']} cualitativo, solo presencia o ausencia")
        payload["lectura"] = preguntar("Lectura", ["No_Detectado", "Detectado"])

    payload["operador"] = preguntar(
        "Operador que corrio el kit",
        por_defecto=(catalogo["operadores"] or ["Ricardo"])[0],
    )

    campo = None
    if preguntar_si_no("\nRegistrar tambien el cuaderno de campo", False):
        fumigo = preguntar(
            "El vecino convencional fumigo hace poco", ["No", "Si", "No_se_sabe"]
        )
        dias = -1
        if fumigo == "Si":
            crudo = preguntar("Dias desde la fumigacion", por_defecto="7")
            dias = int(crudo) if crudo.isdigit() else 7

        campo = {
            "vecino_fumigo_reciente": fumigo,
            "dias_desde_fumigacion_vecina": dias,
            "despulpadora_compartida": preguntar_si_no("Despulpadora compartida", False),
            "sacos_reutilizados": preguntar_si_no("Sacos reutilizados", False),
            "secado_patio_compartido": preguntar_si_no("Secado en patio compartido", False),
            "transporte_compartido": preguntar_si_no("Transporte compartido", False),
            "lavado_equipo_flag": preguntar_si_no("Equipo lavado antes de usar", True),
            "capacitacion_bpa_flag": preguntar_si_no("Productor con capacitacion BPA", True),
            "origen_captura": "formulario_manual",
        }

    print("\nResumen del formulario")
    for clave, valor in payload.items():
        if valor is not None:
            print(f"   {clave:16s} {valor}")
    if campo:
        print(f"   {'cuaderno':16s} si")

    if not preguntar_si_no("\nGuardar", True):
        print("cancelado, no se escribio nada")
        return

    respuesta = enviar_formulario(payload, campo)

    if respuesta.get("ok"):
        fila = respuesta["fila"]
        print(f"\nGuardado {respuesta['id']} en {respuesta['archivo']} (fila {respuesta['filas']})")
        print(f"   resultado calculado por el servidor: {fila['Resultado']}")
        if fila["Resultado"] not in ("Aprobado", "No_Detectado"):
            print("   este lote pasa a critico en el tablero, revisa la alerta")
    else:
        print(f"\nRechazado: {respuesta.get('error')}")


# ===========================================================================
def modo_estado() -> None:
    cola = ColaArchivo()
    info = llamar("/api/estado")
    print("CafeTrace. Estado de la captura")
    print(f"  servidor          {SERVIDOR}  {'activo' if info.get('ok') else 'caido'}")
    print(f"  topico            {TOPICO.relative_to(RAIZ)}")
    print(f"  posicion grupo    {cola.leer_posicion()}")
    print(f"  eventos pendientes {cola.pendientes()}")
    print("  filas en CSV")
    for nombre, total in info.get("conteos", {}).items():
        print(f"    {nombre:14s} {total}")


def main() -> None:
    argumentos = sys.argv[1:]
    modo = argumentos[0] if argumentos else "manual"

    broker = None
    if "broker" in argumentos:
        broker = argumentos[argumentos.index("broker") + 1]

    if modo == "producir":
        cantidad = int(argumentos[1]) if len(argumentos) > 1 and argumentos[1].isdigit() else 40
        producir(cantidad)
    elif modo == "automatico":
        maximo = int(argumentos[1]) if len(argumentos) > 1 and argumentos[1].isdigit() else None
        modo_automatico(maximo, broker)
    elif modo == "manual":
        modo_manual()
    elif modo == "estado":
        modo_estado()
    else:
        print(__doc__)
        raise SystemExit(f"Modo no reconocido: {modo}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\ncancelado")
