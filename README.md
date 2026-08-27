# CafeTrace v1.0 (MVP)

Pasaporte digital de trazabilidad para café orgánico de exportación.
Detecta contaminación cruzada por glifosato **en el centro de acopio**, cuando
el lote todavía se puede segregar, en vez de descubrirla en aduana de destino.

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
index.html                  Layout CSS Grid: KPIs / mapa / alertas / árbol / formulario
styles.css                  Paleta orgánica, responsive, breakpoint tablet en 1024px
vendor/d3.v7.min.js         D3 v7.9.0 vendorizado (debe funcionar offline en acopio)
data/
  peru-departamentos.js     Límites departamentales (GeoJSON WGS84) para d3.geoMercator
  productores.csv           Fincas: geo, certificación declarada, proximidad a convencional
  test_elisa.csv            Resultados del kit de inmunoensayo rápido
  lotes_cafe.csv            Lotes consolidados para exportación
js/
  data-loader.js            Carga concurrente + join + motor de reglas + ledger de auditoría
  app.js                    Controlador: KPIs, selección, formulario de alta, exportación
  modules/
    map-risk.js             Mapa del Perú en Mercator + clustering por zoom + vectores de deriva
    tree-trace.js           Árbol de trazabilidad con bifurcación de lote segregado
    alerts-feed.js          Feed de alertas del motor de reglas
RESPUESTAS.md               Modelo de negocio, costos y estimación de ahorro
```

## Motor de reglas

| Regla | Condición | Riesgo |
|-------|-----------|--------|
| `R0_NO_ORGANICO` | Certificación ≠ Orgánico | No aplica |
| `R1_GLIFOSATO_SOBRE_UMBRAL` | Orgánico y ppm > 0.1 | **Crítico** — segregar ahora |
| `R2_ORGANICO_SIN_TEST` | Orgánico sin test ELISA asociado | **Alto** — bloquear consolidación |
| `R3_DERIVA_POTENCIAL` | Orgánico, conforme, proximidad Alta | **Medio** — monitorear |
| `R4_CONFORME` | Resto | **Bajo** |

El umbral (`0.1 ppm`) y la penalización (`US$50/quintal`) están parametrizados
en `CONFIG`, al inicio de `js/data-loader.js`. Cambiarlos recalcula todo el
dashboard.

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
- **Coherencia de datos:** al registrar un test, el campo `Resultado` se deriva
  del umbral y no de lo que elija el operador, y el `Timestamp` se genera en el
  momento del alta.

## Datos de demostración

6 lotes sintéticos que ejercitan las 5 reglas:

| Lote | Finca | Cert. | ppm | Riesgo | Por qué está |
|------|-------|-------|-----|--------|--------------|
| L201 | La Aurora | Orgánico | 0.02 | Medio | Conforme pero colinda con convencional |
| L202 | El Shambo | Orgánico | 0.00 | Bajo | Caso limpio |
| L203 | Las Palmeras | Convencional | — | No aplica | Fuera de alcance + riesgo mal declarado en el CSV |
| L204 | Vista Hermosa | Orgánico | 0.18 | **Crítico** | Contaminación → segregación → US$4,000 |
| L205 | Bella Vista | Orgánico | 0.01 | Bajo | Caso limpio |
| L206 | Los Cedros | Orgánico | — | **Alto** | Lote orgánico que nunca se testeó |

L206 se agregó al dataset del brief para que la regla R2 (el hueco de
trazabilidad que más nos diferencia) sea visible en la demo. L203 declara
riesgo "Alto" en el CSV mientras el motor calcula "No aplica": esa divergencia
dispara una alerta de auditoría, y es intencional.
