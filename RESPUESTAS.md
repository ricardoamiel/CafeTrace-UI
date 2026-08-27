# CafeTrace — Plataforma digital, modelo de negocio y estimación de ahorro

> Documento de respuesta a las tareas 3 y 4 del brief del equipo.
> Versión 2 — reformula la respuesta inicial y corrige un punto del cálculo
> económico que el jurado casi con seguridad va a cuestionar en la ronda de
> preguntas (ver §3.2).
>
> **Regla de honestidad que aplicamos en todo el documento:** separamos con
> etiquetas lo que es **[DATO]** (fuente pública citada), **[SUPUESTO]**
> (asunción nuestra, explícita y auditable) y **[POR CONFIRMAR]** (pendiente
> de las tareas 2a y 2b de Sofi y Fabiana). Un número sin etiqueta no existe.

---

## 1. Conexión con la plataforma digital y funciones específicas

### 1.1 Cómo se conecta el test con la plataforma

No hay integración de hardware, y eso es una decisión de diseño, no una
limitación. El kit de inmunoensayo rápido tipo ELISA produce un resultado que
el operador lee visualmente o en un lector portátil; conectar ese lector por
API a cada cooperativa multiplicaría el costo y el soporte técnico sin agregar
valor en esta etapa.

El flujo real en el centro de acopio toma menos de un minuto:

| # | Paso | Quién | Dónde |
|---|------|-------|-------|
| 1 | Se toma la muestra del lote que llega | Operador de acopio | Físico |
| 2 | Se corre el kit ELISA | Operador de acopio | Físico |
| 3 | Se registra el resultado (ppm), el `ID_Lote` y el `ID_Productor` | Operador de acopio | Formulario web/móvil |
| 4 | El motor de reglas cruza y clasifica el lote | Plataforma | Automático |
| 5 | Si hay alerta, se decide segregar **antes** de consolidar el contenedor | Supervisor | Decisión comercial |

El punto crítico es el paso 5: el valor no está en detectar, está en detectar
**mientras el lote todavía se puede separar**. Una vez consolidado el
contenedor, la contaminación de 80 quintales arrastra a los 1,000.

**Sobre la conectividad:** los centros de acopio cafetaleros suelen tener señal
intermitente. Por eso el MVP que construimos funciona **100% offline**: se abre
en la tablet sin internet, guarda los registros en el dispositivo y recalcula
todo localmente. La sincronización con la nube es una función de la v2, no un
requisito para operar.

### 1.2 Funciones específicas de ciencia de datos

Estas cuatro ya están implementadas y corriendo en el prototipo:

**a) Vinculación multidimensional (join trazable).** Cada resultado de test se
une con su lote, su finca de origen y la certificación declarada. El resultado
es un *pasaporte digital*: una cadena verificable de cuatro eslabones
—Origen → Verificación ELISA → Lote consolidado → Decisión— exportable como
JSON firmable y entregable al comprador o al auditor de certificación.

**b) Motor de reglas para inconsistencias.** Cuatro reglas en cascada:

| Regla | Condición | Riesgo | Acción |
|-------|-----------|--------|--------|
| R1 | Orgánico declarado **y** glifosato > 0.1 ppm | **Crítico** | Segregar a mercado nacional ahora |
| R2 | Orgánico declarado **y** sin test ELISA asociado | **Alto** | Bloquear consolidación hasta testear |
| R3 | Orgánico, conforme, pero proximidad a convencional = Alta | **Medio** | Re-testear la próxima entrega |
| R4 | Orgánico, conforme, sin proximidad crítica | **Bajo** | Continuar exportación |

R2 es la que más nos diferencia: detecta el lote que **nunca fue testeado**.
Ese es el hueco por donde hoy se cuela la contaminación, y no lo cubre ninguna
auditoría anual documental.

**c) Modelado de riesgo espacial por proximidad.** A partir de las coordenadas
de cada finca calculamos, para cada parcela orgánica, la distancia a la parcela
convencional más cercana. El mapa dibuja ese "vector de deriva" como línea
punteada. Así se prioriza el muestreo: no se testea todo por igual, se testea
primero donde el riesgo geográfico es mayor. Esto reduce el número de kits
necesarios por campaña, que es el costo variable dominante.

**d) Control de consistencia declarado vs. calculado.** La plataforma compara
el riesgo que el registro declara contra el que el motor deduce de la
evidencia, y levanta una alerta de auditoría cuando difieren. Es el mecanismo
que detecta el dato desactualizado o el registro alterado.

### 1.3 Qué NO hace la v1 (decirlo antes de que lo pregunten)

- No certifica: **no reemplaza** a la certificadora orgánica, la alimenta con
  evidencia estructurada.
- No es blockchain. Es un ledger JSON exportable y auditable. Blockchain es
  una respuesta a un problema de confianza entre partes que no se conocen;
  dentro de una cooperativa ese problema no existe todavía, y el costo de
  operarlo sí. Queda como opción para la v3 si el comprador europeo lo exige.
- No sustituye el análisis de laboratorio confirmatorio. El ELISA es un
  **tamizaje**: separa lo dudoso de lo limpio rápido y barato. Un positivo
  crítico debe confirmarse por cromatografía antes de una decisión legal.

---

## 2. Modelo de negocio, costos y mantenimiento

### 2.1 Principio: el kit no se vende solo

El kit ELISA aislado es un commodity: cualquiera lo importa. Lo que no se puede
comprar por separado es la **trazabilidad acumulada** —el historial de qué
finca, en qué campaña, con qué resultado— porque ese activo se construye con el
uso y es lo que se le enseña al comprador europeo para negociar precio.

Por eso: **el kit siempre viene con plataforma. No hay SKU "solo kit".** Vender
el kit suelto convertiría el negocio en importación de reactivos, con margen
bajo y sin barrera de entrada.

### 2.2 Estructura de precios propuesta

Modelo híbrido: una suscripción baja que da acceso y continuidad, más un cobro
por test que escala con el volumen real de acopio. La suscripción baja quita la
barrera de entrada; el cobro por test alinea nuestro ingreso con el uso.

| Plan | Perfil | Suscripción | Por test | Incluye |
|------|--------|-------------|----------|---------|
| **Piloto** | 1 campaña, cooperativa pequeña | S/ 0 | costo del kit + margen | Plataforma completa, 1 usuario, datos exportables |
| **Cooperativa** | < 2,000 qq/campaña | S/ 150–250 /mes **[SUPUESTO]** | costo del kit + margen reducido | Multiusuario, mapa de riesgo, alertas, ledger exportable, soporte |
| **Exportadora** | multi-cooperativa | S/ 600–900 /mes **[SUPUESTO]** | negociado por volumen | Todo lo anterior + consolidado multi-proveedor + reporte para el comprador |

Los rangos en soles son **[SUPUESTO]** nuestro y están anclados a un criterio
simple, no a una encuesta: la suscripción anual del plan Cooperativa
(S/ 1,800–3,000 ≈ US$ 480–800) tiene que quedar **muy por debajo** del ahorro
de una sola campaña (§3), o el cliente no tiene razón para pagarla. Validar con
2–3 cooperativas antes de la final del 30 de octubre.

El precio por test **[POR CONFIRMAR]** depende del costo unitario del kit, que
es la tarea 2a de Sofi. No lo inventamos aquí.

### 2.3 ¿Cuesta más comprar el kit "con plataforma"?

No, y conviene decirlo así de directo: **el acceso a la plataforma va incluido
en el precio del test.** El cliente ve un solo precio por test realizado. La
suscripción mensual no compra el software —compra continuidad: el historial
entre campañas, el soporte y el reporte para el comprador.

Es deliberado. Si cobráramos la plataforma aparte, la cooperativa la trataría
como gasto prescindible y compraría solo kits, que es exactamente el escenario
que destruye nuestro margen y nuestra diferenciación.

### 2.4 Mantenimiento

Corre por nuestra cuenta, incluido en la suscripción. La cooperativa **no
necesita personal de TI**, y esa es una condición de adopción, no un detalle:
en cooperativas de 200–500 socios no hay a quién asignarle un servidor.

Nuestro lado del mantenimiento es deliberadamente barato:

| Concepto | Estimado mensual **[SUPUESTO]** |
|----------|-------------------------------|
| Hosting estático (Netlify / GitHub Pages / Vercel) | S/ 0 en tier gratuito |
| Base de datos + auth gestionada (Supabase/Firebase, v2) | S/ 0–90 según volumen |
| Dominio y certificado | ~S/ 6 |
| Horas de mantenimiento del equipo | variable, absorbido en el equipo |

El MVP actual es **estático puro**: HTML + CSS + JavaScript + D3.js, sin
backend. Se despliega en cualquier hosting gratuito y no tiene costo marginal
por usuario. Eso mantiene el punto de equilibrio muy bajo mientras validamos.

### 2.5 ¿Pago único o suscripción?

**Suscripción, no pago único.** Tres razones:

1. Un pago único obligaría a cobrar por adelantado más de lo que la cooperativa
   puede desembolsar antes de la campaña, cuando justamente tiene menos caja.
2. El valor de la plataforma **crece con el historial acumulado**; un pago único
   nos desalinearía de mantenerla viva.
3. La suscripción financia el mantenimiento y el soporte de forma predecible, y
   es lo que hace sostenible no cobrarle TI a la cooperativa.

---

## 3. Potencial de detección: estimación del ahorro

### 3.1 El cálculo directo (escenario base)

**[DATO]** La UE castiga el precio del café orgánico con hasta **US$ 50 por
quintal** por rastros de glifosato (Gestión, 15/11/2019). Con 1 quintal = 100 kg,
equivale a US$ 0.50/kg.

**[SUPUESTO]** Cooperativa mediana que exporta 1,000 qq declarados orgánicos y
un 5% de lotes en riesgo (50 qq) que se detectan y segregan a tiempo.

```
50 qq × US$ 50/qq = US$ 2,500 de penalización evitada por campaña
```

Nuestro prototipo calcula exactamente esto en tiempo real. Con el dataset de
demostración: 80 qq segregados (lote L204, 0.18 ppm) × US$ 50 = **US$ 4,000**.

### 3.2 Corrección importante: bruto vs. neto

⚠️ **Este es el punto donde nos van a apretar en la ronda de preguntas, y hay
que llegar con la respuesta puesta.**

Los US$ 2,500 son la **penalización bruta evitada**. Pero el café segregado no
se vende al precio orgánico: se vende como convencional, y ahí se pierde el
diferencial orgánico sobre esos mismos 50 qq. El cálculo honesto compara los
dos escenarios completos:

Sea `P_org` el precio orgánico de exportación, `P_conv` el precio convencional
local y `δ = P_org − P_conv` el diferencial orgánico.

| Escenario | Qué pasa | Ingreso por quintal afectado |
|-----------|----------|------------------------------|
| **A — Sin CafeTrace** | Embarca como orgánico, el comprador detecta en destino | `P_org − 50` |
| **B — Con CafeTrace** | Se segrega y se vende local como convencional | `P_conv = P_org − δ` |

```
Ganancia neta de B sobre A = US$ 50 − δ  (por quintal segregado)
```

Es decir: **el ahorro neto directo es menor que US$ 50/qq**, y es mayor cuanto
menor sea el diferencial orgánico. Con un δ de US$ 20–30/qq **[SUPUESTO, POR
CONFIRMAR con precios FOB reales]**, el ahorro neto directo ronda los
**US$ 20–30/qq**, o sea **US$ 1,000–1,500** en el escenario base.

Recomendación para el pitch: **presentar los US$ 2,500 como "penalización
evitada" (que es literalmente lo que dice la fuente) y tener el número neto
listo para la pregunta.** Decir el número neto antes de que nos lo saquen
transmite dominio del tema; que nos lo saquen a nosotros, lo contrario.

### 3.3 El valor que no cabe en el cálculo por quintal

Y aquí está el argumento fuerte, el que hace que la discusión bruto-vs-neto sea
secundaria. Los US$ 50/qq son la penalización sobre el volumen afectado. Los
tres riesgos siguientes son de otra magnitud:

1. **Contaminación del contenedor completo.** Si los 50 qq contaminados se
   consolidan con los otros 950, el análisis en destino no se hace por lote:
   se hace por embarque. El riesgo pasa de 50 qq a 1,000 qq. La segregación
   temprana es lo que convierte una pérdida potencial de US$ 50,000 en una de
   US$ 1,000–2,500.
2. **Descertificación de la cooperativa.** Perder el sello orgánico cierra el
   acceso al mercado de valor agregado para **todos** los socios y por varias
   campañas. Es un riesgo de continuidad del negocio, no una línea de costo.
3. **Poder de negociación.** Un exportador que llega con historial verificable
   de trazabilidad negocia distinto que uno que llega con una auditoría anual
   en papel. Este beneficio es real y no lo sabemos cuantificar todavía; lo
   decimos así.

**El encuadre correcto de la propuesta no es "ahorramos US$50 por quintal". Es:
convertimos una pérdida catastrófica e impredecible en un costo pequeño,
conocido y decidido por nosotros.**

### 3.4 Cómo lo calcula la plataforma

En el dashboard, en vivo, sin intervención manual:

- **Quintales monitoreados** — volumen total bajo trazabilidad.
- **Tasa de contaminación cruzada (%)** — lotes críticos ÷ lotes orgánicos
  testeados. Denominador explícito: solo la población testeada, porque es la
  única en la que la contaminación es observable.
- **Ahorro económico estimado** — quintales segregados × US$ 50/qq.
- **Cobertura de testeo ELISA (%)** — lotes orgánicos testeados ÷ lotes
  orgánicos totales. Es el KPI de disciplina operativa: una cobertura del 80%
  significa que 1 de cada 5 lotes se está embarcando a ciegas.

### 3.5 Supuestos a validar antes del 30 de octubre

| # | Supuesto | Cómo validarlo | Responsable |
|---|----------|----------------|-------------|
| 1 | Tasa de lotes en riesgo del 5% | Datos históricos de rechazo de 2–3 cooperativas | Equipo |
| 2 | Diferencial orgánico δ (US$/qq) | Precios FOB orgánico vs. convencional, campaña 2025-26 | Ricardo / Juan |
| 3 | Costo unitario del kit y ensayos por kit | Cotización a proveedor | Sofi (2a) / Fabiana (2b) |
| 4 | Umbral de 0.1 ppm como criterio de corte | LMR vigente UE para glifosato en café + sensibilidad del kit | Fabiana |
| 5 | Disposición a pagar (S/ /mes) | Entrevista a 3 cooperativas | Equipo |

El umbral de 0.1 ppm está **parametrizado en el código** (`UMBRAL_GLIFOSATO_PPM`
en `js/data-loader.js`): cuando el dato real llegue se cambia en una línea y
todo el motor de reglas, los KPIs y las alertas se recalculan solos.

---

## 4. Respuestas de bolsillo para la ronda de preguntas

Los 2 minutos de preguntas de la semifinal deciden más que los 3 de
presentación. Estas son las cinco que más probablemente caigan:

**"¿Por qué una cooperativa pagaría por esto en vez de simplemente testear?"**
Porque el test suelto responde "¿este lote está contaminado?". La plataforma
responde "¿qué lotes ni siquiera testeé?", que es la pregunta que realmente
causa el rechazo en destino. Además el historial acumulado es lo que se le
muestra al comprador para negociar.

**"¿No existe ya esto?"** Existen la certificación documental (anual, en
destino) y el análisis de laboratorio (caro, lento, centralizado). Lo que no
existe al alcance de una cooperativa pequeña es verificación **en el punto de
acopio, antes de consolidar**. La innovación es de sistema y de momento, no de
química.

**"¿Y si el operador registra mal el dato a propósito?"** La v1 detecta la
inconsistencia estructural (lote sin test, riesgo declarado que no coincide con
la evidencia), no el fraude deliberado con datos coherentes. Para eso hacen
falta doble registro y firma del resultado, que es v2. Lo decimos: no
prometemos anti-fraude en la v1.

**"¿Por qué no blockchain?"** Porque el problema de la cooperativa hoy no es la
confianza entre partes anónimas, es la ausencia total de registro. Resolver eso
primero cuesta casi nada; blockchain agrega costo operativo antes de que exista
el dato que valdría la pena anclar.

**"¿Su ahorro no es en realidad menor a US$50/qq?"** Sí —y aquí se contesta
§3.2 completo, de memoria y sin dudar. Es la pregunta que mejor se puede
convertir a favor.

---

## Fuentes

- Gestión. (2019, 15 de noviembre). *UE castiga el precio del café orgánico con
  hasta US$ 50 por quintal debido a rastros de glifosato.*
  https://gestion.pe/economia/ue-castiga-el-precio-del-cafe-organico-con-hasta-us-50-por-quintal-debido-a-rastros-de-glifosato-noticia/
- FAO. (s.f.). *Buenas cifras de negocio para las exportaciones de café orgánico
  en Perú.* Agronoticias.
  https://www.fao.org/in-action/agronoticias/detail/es/c/509534/
- Perfect Daily Grind Español. (2021, 6 de octubre). *Cómo calcular el precio de
  venta de tu café.*
  https://perfectdailygrind.com/es/2021/10/06/como-calcular-el-precio-de-venta-de-tu-cafe/
