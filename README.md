# CafeTrace v1.1 (MVP)

Pasaporte digital de trazabilidad para café orgánico de exportación.
Detecta contaminación cruzada por agroquímicos **en el centro de acopio**, cuando
el lote todavía se puede segregar, en vez de descubrirla en aduana de destino.

No innovamos el inmunoensayo: innovamos su **uso**. Cada lote orgánico se
verifica contra un **panel de 4 kits ELISA** comerciales, no contra un solo
kit de glifosato. Un lote no está "verificado" por tener un test: lo está
cuando el panel queda cerrado.

Disrupton 2026 · Eje 1: sistemas de trazabilidad, calidad y verificación.

## Cómo ejecutarlo

**Opción A — doble clic.** Abrir `index.html` en el navegador. Funciona sin
servidor y sin internet: si el navegador bloquea la lectura de los CSV bajo
`file://`, el dashboard cae automáticamente a un dataset embebido idéntico y lo
indica en la cabecera (`Fuente: seed-embebido`).

**Opción B — servidor local** (lee los CSV reales de `/data`):

```bash
python3 -m http.server 8000
# http://localhost:8000
```

**Despliegue:** es un sitio estático puro. Se sube tal cual a Netlify, GitHub
Pages, Vercel o cualquier hosting. No hay backend ni build step.

## Estructura

```
index.html                  Layout CSS Grid: KPIs / mapa / alertas / plan / árbol / formulario
styles.css                  Paleta orgánica, responsive, breakpoint tablet en 1024px
vendor/d3.v7.min.js         D3 v7.9.0 vendorizado (debe funcionar offline en acopio)
data/
  peru-departamentos.js     Límites departamentales (GeoJSON WGS84) para d3.geoMercator
  productores.csv           Fincas: geo, certificación, proximidad a convencional, exportadora
  test_elisa.csv            Resultados del panel: una fila por kit corrido sobre un lote
  lotes_cafe.csv            Lotes consolidados para exportación
js/
  data-loader.js            Carga concurrente + join + panel + motor de reglas + ledger
  app.js                    Controlador: filtros, KPIs, selección, formulario, exportación
  modules/
    map-filters.js          Barra de filtros del mapa (exportadora / tamaño / agroquímico / destino)
    map-risk.js             Mapa del Perú en Mercator + clustering por zoom + vectores de deriva
    tree-trace.js           Árbol de trazabilidad con bifurcación de lote segregado
    alerts-feed.js          Feed de alertas: 4 bullets + detalle desplegable
    advisor.js              Análisis parametrizado del lote (scorecard de factores)
    ingesta.js              Escritura a CSV via servidor, con cola local si no hay conexion
    optimizer.js            Optimizador de embarque: mochila exacta con presupuesto de riesgo
captura/
  index.html                Formulario de campo responsive, movil primero
  captura.css               Objetivos tactiles de 48 px, una columna hasta 720 px
  captura.js                Cola local sin conexion y reintento al reconectar
scripts/
  servidor_local.py         Servidor de ingesta que escribe en los CSV
  generar_data_sintetica.py Generador fisicamente informado (pluma gaussiana)
  completar_formulario.py   Llenado automatico por cola de eventos, o manual
  construir_notebook.py     Genera el notebook desde celdas declaradas en texto
  calcular_priors.py        Probabilidades conjuntas de exceso por subconjunto de kits
  verificar_optimizador.py  Contrasta el optimizador del tablero contra PuLP con CBC
notebooks/
  pipeline_ml_optimizacion.ipynb   Pipeline completo de punta a punta
data/
  raw/{app,apis,elisa}      Datos sinteticos crudos por fuente
  clean/{app,apis,elisa}    Datos tipados y resumidos para el pipeline
  panel_agroquimicos.json   Definicion unica de kits y umbrales
  priors_riesgo.json        Priors empiricos que consume el optimizador del tablero
resultados/
  eda/ modelo/ optimizacion/   Figuras, metricas, artefactos y decisiones
report.md                   Informe tecnico del modelo y la optimizacion
RESPUESTAS.md               Modelo de negocio, costos y estimación de ahorro
```

## Captura de datos y pipeline de modelado

El MVP tiene dos mitades. La primera es el tablero de monitoreo, descrito
mas abajo. La segunda es la cadena que va de la captura en campo al plan de
segregacion de lotes, y se ejecuta asi.

### Servidor local de ingesta

Resuelve el hueco que tenia la version anterior: el formulario guardaba en
el navegador y el CSV nunca se actualizaba. Ahora las altas se escriben en
disco.

```bash
python3 scripts/servidor_local.py
```

Levanta en el puerto 8777 y sirve tres cosas: el tablero, el formulario de
campo y la API de ingesta. Es biblioteca estandar, sin dependencias y sin
nube. Con el servidor arriba, el tablero muestra escritura en CSV en la
cabecera; sin el, cae a almacenamiento del navegador y sube lo acumulado
cuando el servidor vuelve.

### Formulario de captura de campo

En http://127.0.0.1:8777/captura/index.html. Diseno movil primero, objetivos
tactiles de 48 pixeles, cola local para trabajar sin senal. Captura el
resultado del kit, que alimenta al tablero, y de forma opcional el cuaderno
de campo, que alimenta al modelo.

### Llenado del formulario desde Python

Dos modos, ambos terminan escribiendo en los mismos CSV.

```bash
python3 scripts/completar_formulario.py producir 40      # siembra la cola
python3 scripts/completar_formulario.py automatico       # consume y autocompleta
python3 scripts/completar_formulario.py manual           # llenado por consola
python3 scripts/completar_formulario.py estado           # posicion y pendientes
```

El modo automatico consume una cola de eventos ya ingeridos, que es lo que
corresponde a una arquitectura orientada a eventos. En este MVP el topico es
un archivo de una linea por evento y el avance del grupo consumidor es un
archivo de posicion, con la misma interfaz que tendria un broker real. Si la
biblioteca de Kafka esta instalada y se indica un broker, se usa el broker.

### Generacion de data sintetica

```bash
python3 scripts/generar_data_sintetica.py
```

Genera 4,200 lotes sobre 120 fincas a partir de un modelo de pluma
gaussiana, no de ruido aleatorio. Escribe en data/raw separado por fuente y
en data/clean ya tipado y resumido. Imprime el reparto de hallazgos entre la
via de deriva y la via operativa, que es la instrumentacion que permite
saber si una de las dos quedo invisible.

### Pipeline de aprendizaje y optimizacion

```bash
jupyter execute --inplace notebooks/pipeline_ml_optimizacion.ipynb
```

Cruce con DuckDB, analisis exploratorio, escalado y bucketizacion optima,
codificacion con mapeo explicito, seleccion de variables en tres etapas,
calibracion isotonica con validacion por deciles, modelo multietiqueta por
agroquimico y modelo de optimizacion entera mixta. Deja todo en resultados.

El informe tecnico detallado esta en report.md.

## Motor de reglas

| Regla | Condición | Riesgo |
|-------|-----------|--------|
| `R0_NO_ORGANICO` | Certificación ≠ Orgánico | No aplica |
| `R1_RESIDUO_SOBRE_UMBRAL` | Algún kit del panel supera su criterio | **Crítico** — segregar ahora |
| `R2_ORGANICO_SIN_TEST` | Orgánico sin ningún resultado ELISA | **Alto** — bloquear consolidación |
| `R3_PANEL_INCOMPLETO` | Orgánico con kits del panel sin correr | **Alto** — cerrar el panel |
| `R4_DERIVA_POTENCIAL` | Panel cerrado y conforme, proximidad Alta | **Medio** — monitorear |
| `R5_CONFORME` | Resto | **Bajo** |

## Panel de agroquímicos

Los cuatro kits que debe cerrar cada lote orgánico. Un ELISA real reporta una
de dos lecturas, y el panel declara cuál: **cuantitativa** (ppm contra umbral)
o **cualitativa** (presencia/ausencia). En un lote orgánico cualquier detección
cualitativa ya es hallazgo: no hay margen de umbral que negociar.

| Agroquímico | Clase | Kit | Lectura | Criterio |
|-------------|-------|-----|---------|----------|
| Glifosato | Herbicida | `ELISA_GLY_96` | Cuantitativa | > 0.10 ppm |
| Clorpirifos | Insecticida organofosforado | `ELISA_CPF_96` | Cuantitativa | > 0.05 ppm |
| Cipermetrina | Insecticida piretroide | `ELISA_PYR_48` | Cualitativa | detección |
| Carbendazim | Fungicida bencimidazol | `ELISA_CBZ_96` | Cuantitativa | > 0.10 ppm |

El panel, sus umbrales y la penalización (`US$50/quintal`) están parametrizados
en `PANEL` y `CONFIG`, al inicio de `js/data-loader.js`. Agregar un quinto kit
es agregar una entrada al array: las reglas, los KPIs, el filtro del mapa y el
formulario de alta se adaptan solos.

## Filtros del mapa

Cuatro dimensiones, las mismas que usa el supervisor al armar un embarque:
**empresa/exportadora**, **tamaño de lote** (< 100 / 100–199 / ≥ 200 qq),
**tipo de agroquímico** (residuo detectado por el panel) y **destino**.

El filtro es transversal: KPIs, mapa y alertas leen siempre el mismo
subconjunto. Filtrar "Perhusa + Alemania" y que los KPIs siguieran mostrando el
total de la cooperativa daría una lectura falsa de la cartera que se revisa.

## Alertas

Cada tarjeta muestra **cuatro bullets y nada más** — ubicación, tipo de
agroquímico, empresa/exportadora y resultado del test — porque se leen en una
tablet, en el acopio y sin tiempo.

"Ver más detalles" despliega el análisis de `advisor.js`: un scorecard
determinista que pondera severidad del residuo, multirresiduo, cobertura del
panel, volumen, mercado destino, proximidad a convencional y consistencia del
dato; y devuelve prioridad, factores, exposición económica y plan de acción.
Es reproducible y auditable, que es lo que exige una decisión de segregación
que después se defiende ante un auditor.

`CT.Advisor.proveedor` es el punto de extensión para que en la v2 redacte esa
recomendación un LLM, manteniendo el mismo contrato de salida. Mientras sea
`'reglas'` no hay llamada de red y el dashboard funciona sin conexión.

## Plan de embarque

El tablero no se queda en describir el riesgo: decide. La seccion de plan
resuelve, dentro del navegador, el mismo problema de optimizacion entera que
el notebook, y responde a una pregunta operativa concreta: que lotes van al
contenedor organico y cuales se redirigen a convencional, dado un presupuesto
de riesgo para el contenedor.

Cada lote aporta la prima organica menos el costo esperado de contaminacion,
y el conjunto exportado debe mantener el riesgo ponderado por quintal dentro
de la tolerancia que elige el supervisor en el selector. La formulacion tiene
coeficientes negativos para los lotes limpios, de modo que no es una mochila
estandar; el modulo la normaliza con la sustitucion y igual a uno menos x y la
resuelve por programacion dinamica exacta sobre la capacidad discretizada.
scripts/verificar_optimizador.py contrasta el resultado contra PuLP con CBC en
cuarenta escenarios: coincidencia exacta en todos, con la peor brecha en el
orden del ruido de punto flotante.

La probabilidad de cada lote declara su origen en la propia tarjeta:

* medido, cuando el panel encontro un residuo sobre el umbral.
* panel cerrado, cuando los cuatro kits se corrieron y ninguno excedio.
* prior, cuando quedan kits pendientes. Se usa la probabilidad empirica
  conjunta de que al menos uno de los faltantes exceda, condicionada al grupo
  de proximidad de la finca, calculada por scripts/calcular_priors.py. Es
  conjunta y no producto de marginales porque los excesos estan
  correlacionados: suponer independencia sobreestimaria el riesgo.
* fuera de alcance, cuando el lote no es organico.

La cuarentena espacial sigue una jerarquia de evidencia. Una finca foco, con
contaminacion confirmada en sitio, queda bloqueada por completo. Una finca
colindante dentro de 800 m solo bloquea sus lotes con panel abierto: si el
panel esta cerrado y conforme, la medicion directa manda sobre la cercania y
el lote queda exento. La proximidad es un sustituto de lo que no se observo, y
deja de aportar cuando el desenlace ya se midio.

Los filtros del mapa acotan que lotes entran al plan, pero no la cuarentena:
esa se calcula siempre sobre la cartera completa. Ocultar la finca foco con un
filtro no aleja la parcela contaminada de su vecino, y si el bloqueo dependiera
de la vista, un filtro de lectura levantaria una restriccion de contencion.

El plan se descarga como CSV con una fila por lote, su probabilidad, su
origen, su decision y su motivo, que es lo que despues se defiende ante un
auditor.

## Mapa de riesgo

Mapa coroplético del Perú en proyección **Mercator** (`d3.geoMercator`),
ajustado con `fitExtent` al bounding box de los límites departamentales: el
encuadre es el Perú y solo el Perú. El departamento que concentra el acopio se
resalta automáticamente (se deduce con `d3.geoContains`, no está codificado a
mano).

**Clustering por zoom.** Las fincas de una cooperativa caben en ~0.03° (unos
3 km): a escala nacional serían un solo píxel. Por eso el mapa agrupa —marcador
agregado por zona de acopio cuando está alejado, fincas individuales al
acercarse (umbral k = 25)—. Tres vistas: *Perú*, *Departamento*, *Zona de
acopio*, más rueda y arrastre.

Los marcadores se **contra-escalan por 1/k** en cada zoom para conservar su
tamaño en pantalla. La retícula se acota a la ventana visible y con un techo de
líneas: `d3.geoGraticule()` cubre todo el globo por defecto y, con paso fino,
genera decenas de miles de meridianos que congelan el navegador.

Cada vector de deriva va rotulado con la **distancia geodésica real** a la
finca convencional más cercana (`d3.geoDistance`), y hay barra de escala en km.
Ese número es el que sostiene el argumento de riesgo por proximidad.

## Detalles de implementación

- **Sin ES modules, a propósito.** Los módulos ES exigen servidor HTTP por CORS.
  Con el patrón IIFE + namespace global `CT`, el dashboard también abre con
  doble clic, que es el escenario real de un supervisor con una tablet sin
  conexión. El código sigue siendo un archivo por responsabilidad.
- **Ledger de auditoría.** Cada carga imprime en consola un JSON estructurado
  con la cadena de 4 etapas de cada lote (Origen → Verificación → Consolidación
  → Decisión). El botón *Exportar ledger JSON* lo descarga como archivo.
- **Altas locales.** El formulario persiste en `localStorage` y vuelve a
  ejecutar todo el pipeline sin recargar. *Limpiar altas locales* restaura el
  dataset semilla.
- **Deep link.** `index.html?lote=L204` abre directamente el pasaporte de ese
  lote — sirve para compartir un caso puntual con el comprador o el auditor.
- **Coherencia de datos:** al registrar un test, el formulario pide ppm o
  lectura cualitativa según el kit elegido —no ambos—, el `Resultado` se deriva
  del umbral y no de lo que elija el operador, y el `Timestamp` se genera en el
  momento del alta.

## Datos de demostración

7 lotes sintéticos que ejercitan las 6 reglas y las 4 exportadoras:

| Lote | Finca | Exportadora | Panel | Riesgo | Por qué está |
|------|-------|-------------|-------|--------|--------------|
| L201 | La Aurora | Perhusa | 4/4 conforme | Medio | Conforme pero colinda con convencional |
| L202 | El Shambo | Coop. Norandino | 4/4 conforme | Bajo | Caso limpio |
| L203 | Las Palmeras | Cenfrocafe | — | No aplica | Fuera de alcance + riesgo mal declarado en el CSV |
| L204 | Vista Hermosa | Perhusa | glifosato 0.18 + cipermetrina | **Crítico** | Multirresiduo → segregación → US$4,000 |
| L205 | Bella Vista | Olam Perú | clorpirifos 0.07 | **Crítico** | Contaminación que un panel de solo glifosato **no habría visto** |
| L206 | Los Cedros | Coop. Norandino | 2/4 kits | **Alto** | Panel abierto: faltan clorpirifos y carbendazim |
| L207 | El Shambo | Coop. Norandino | 0/4 kits | **Alto** | Lote orgánico que nunca se testeó |

L205 es el caso que justifica el panel: glifosato conforme (0.01 ppm) y el kit
de clorpirifos igual encuentra residuo. Con un solo kit el lote embarcaba.

L203 declara riesgo "Alto" en el CSV mientras el motor calcula "No aplica", y
L205 declara "Bajo" mientras el motor calcula "Crítico": esas divergencias
disparan alertas de auditoría, y son intencionales.
