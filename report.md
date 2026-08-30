# CafeTrace. Informe tecnico del modelo de aprendizaje y del modelo de optimizacion

Disrupton 2026. Eje de sistemas de trazabilidad, calidad y verificacion.

Este informe documenta el pipeline implementado en
notebooks/pipeline_ml_optimizacion.ipynb. Cubre la generacion de datos, la
construccion del clasificador de riesgo, su calibracion, y el modelo de
optimizacion entera mixta que traduce probabilidades en decisiones de
segregacion de lotes.

Todas las cifras citadas provienen de la ejecucion registrada en
resultados/resumen_ejecucion.json con semilla 20260829.

## 1. Planteamiento

### 1.1 El problema

Un lote de cafe declarado organico puede llegar contaminado por
agroquimicos sin que nadie lo detecte hasta la aduana de destino. La
penalizacion de referencia es de cincuenta dolares por quintal y el riesgo
de fondo es la descertificacion de toda la cooperativa. El unico momento en
que la perdida todavia se puede evitar es el centro de acopio, antes de
consolidar el contenedor.

La plataforma no innova el inmunoensayo. Innova su uso: en vez de un unico
kit de glifosato, declara un panel de cuatro kits comerciales y considera
verificado un lote solo cuando el panel esta cerrado. Los cuatro kits son
glifosato, clorpirifos, cipermetrina y carbendazim, con dos tipos de
lectura, cuantitativa en ppm y cualitativa de presencia o ausencia.

### 1.2 Las dos mitades del problema

**Prediccion.** Estimar la probabilidad de que un lote este contaminado
usando solo lo observable antes de correr el kit: geometria de la parcela,
meteorologia de la ventana de aplicacion y practicas de beneficio
declaradas en el cuaderno de campo.

**Decision.** Convertir esas probabilidades en un plan de segregacion que
maximice el valor comercial sin romper la tolerancia de riesgo que acepta
el comprador para el contenedor.

Un clasificador por si solo no resuelve el problema. Devuelve un puntaje
por lote, pero la decision de embarcar no es lote por lote: el contenedor
es una unidad y el riesgo se agrega dentro de el. Por eso el clasificador
alimenta a un optimizador y no directamente a una alerta.

### 1.3 Prioridad de la metrica

La metrica principal es F1, con prioridad explicita al recall. La asimetria
de costos lo obliga:

* Un falso positivo manda a mercado convencional un lote que estaba limpio.
  Cuesta la diferencia de precio, cincuenta dolares por quintal.
* Un falso negativo embarca un lote contaminado. Cuesta la penalizacion, el
  arrastre sobre el resto del contenedor y el riesgo de certificacion.

El umbral operativo no se elige donde F1 es maximo en terminos absolutos,
sino donde F1 es maximo entre los umbrales que alcanzan un piso de recall
del ochenta por ciento sobre el conjunto de calibracion.

## 2. Generacion de datos sinteticos

Sin dataset masivo de campo, el generador construye los datos a partir de
leyes fisicas y correlaciones reales, no de ruido aleatorio. Esta en
scripts/generar_data_sintetica.py y produce 4,200 lotes sobre 120 fincas y
608 dias de serie meteorologica.

### 2.1 Cadena de simulacion

La contaminacion llega al grano por dos vias independientes, y el generador
modela ambas por separado para que el modelo pueda aprender las dos.

**Via de deriva.** El vecino convencional aplica agroquimico en el lindero
y el viento lo transporta. Se descompone la distancia al lindero en su
componente a favor del viento y su componente transversal:

    y = d por sin(theta)      desplazamiento transversal al eje del viento
    x = d por cos(theta)      recorrido a favor del viento

La concentracion residual combina tres terminos:

    C_residual = C0 por exp(menos y^2 / (2 sigma_y^2)) por dilucion por transporte

donde sigma_y es el ancho de pluma, que crece con la distancia recorrida y
con la turbulencia que introduce el viento, y la dilucion cae con el
recorrido respecto de una distancia de referencia de ciento veinte metros,
que es la distancia a la que se caracteriza la deriva en ensayos de campo.

Sobre ese nucleo actuan cinco moduladores fisicos: lavado por lluvia
acumulada, escorrentia por pendiente, atenuacion por barrera viva en el
lindero, decaimiento desde la fecha de fumigacion declarada y persistencia
por dias secos consecutivos.

**Via operativa.** La contaminacion cruzada por equipo compartido, tal como
la define la arquitectura:

    Riesgo_herramienta = Bernoulli(p = 0.8 si compartio equipo sin lavar)

La probabilidad baja a 0.34 cuando solo hubo sacos reutilizados, a 0.22
cuando solo hubo patio de secado compartido, y a 0.04 en el caso limpio.

**Target ELISA.** Las dos vias se suman con ruido blanco del inmunoensayo:

    ELISA_cuantitativo = max(0, C_residual + Riesgo_herramienta + epsilon)
    ELISA_binario      = 1 si ELISA_cuantitativo supera el criterio del kit

El criterio es el umbral en ppm para los kits cuantitativos y el propio
limite de deteccion para el cualitativo, porque un kit de presencia no
entrega magnitud y en un lote organico cualquier deteccion ya es
incumplimiento.

### 2.2 Calibracion del generador y por que importa

La primera version del generador produjo un dataset inservible para el
proposito del proyecto. La razon fue geometrica: al usar la distancia
completa dentro de la exponencial gaussiana, el termino colapsaba a valores
del orden de diez elevado a menos seis a las distancias reales del terreno,
que tienen mediana de 214 metros. La deriva quedaba en cero y toda la
contaminacion provenia de la via operativa.

El sintoma era claro en el modelo entrenado sobre esos datos: las variables
de importancia SHAP eran exclusivamente operativas y ninguna variable de
distancia, viento o topografia aparecia. Es decir, la mitad de la
arquitectura propuesta quedaba sin evidencia que la respaldara.

La correccion fue distinguir el desplazamiento transversal del recorrido a
favor del viento, que es lo que dice el modelo de pluma gaussiana, y
calibrar tres constantes con significado fisico: coeficiente de dispersion
lateral de 0.45, distancia de referencia de ciento veinte metros y
exponente de dilucion de 0.9. Con eso el reparto quedo en treinta y ocho
por ciento de hallazgos dominados por deriva y sesenta y dos por ciento
dominados por la via operativa, con una tasa global de contaminacion del
25.95 por ciento.

El generador imprime ese reparto en cada corrida. Es instrumentacion
deliberada: sin ella no hay forma de saber si una de las dos vias quedo
invisible.

### 2.3 Estructura de salida

Los datos se organizan por capa y por fuente:

    data/raw/app        lotes cosechados y cuaderno de campo digital
    data/raw/apis       capa geografica de fincas y meteorologia diaria
    data/raw/elisa      resultados de laboratorio por muestra y por kit

    data/clean/app      booleanos tipados y derivadas operativas
    data/clean/apis     meteorologia resumida en ventana de quince dias
    data/clean/elisa    panel por lote, una columna por kit, mas la etiqueta

Las variables latentes del generador, es decir que agroquimico usa
realmente cada vecino y cuanto aporto cada via, no salen a la capa
procesada. Son informacion que en operacion nadie observa y entregarlas al
modelo seria fuga.

## 3. Ingesta y cruce de tablas

Las tres fuentes llegan con granularidades distintas: un registro por lote
en la aplicacion de campo, una serie diaria por finca en las interfaces
externas, y un resultado por muestra y kit en el laboratorio.

El cruce se resuelve con DuckDB sobre los CSV de la capa procesada. La
eleccion no es estetica: la serie meteorologica tiene 72,960 filas contra
4,200 de lotes, dos ordenes de magnitud de diferencia, y DuckDB resuelve
las uniones leyendo columna por columna sin materializar tablas intermedias
en memoria. Una vez consolidada la tabla ancha de 4,200 filas por 44
columnas, que cabe holgadamente en memoria, se pasa a pandas para el
modelado y se libera con el recolector de basura lo que ya no se usa.

La union de la meteorologia merece una nota. La tabla ya viene resumida en
la ventana de quince dias previos a la cosecha, que es el periodo en que la
aplicacion del vecino puede alcanzar al lote. Cruzar el clima del dia de la
entrega no tendria sentido fisico. Ademas, la direccion del viento se
promedia por componentes vectoriales y no en grados, porque el promedio
aritmetico entre 350 y 10 grados daria 180, que es exactamente la direccion
contraria a la real.

## 4. Preparacion de variables

### 4.1 Codificacion categorica con mapeo explicito

Cada variable categorica se codifica a entero y el diccionario de
correspondencia se guarda en resultados/modelo/mapas_categorias.json. Sin
ese mapeo el modelo entrenado es inservible en produccion: no habria forma
de saber que entero corresponde a que exportadora. El mapeo se construye
ordenando los valores alfabeticamente para que sea reproducible entre
corridas.

Se codificaron cinco variables: variedad con cinco niveles, destino
previsto con siete, identificador de tecnico con doce, declaracion de
fumigacion del vecino con tres y empresa exportadora con cuatro.

### 4.2 Escalado

Se ajusta un escalador estandar sobre las variables numericas. Los modelos
de arboles no lo necesitan, pero se calcula y se guarda por dos razones: la
regresion logistica que sirve de referencia si lo requiere, y el escalador
es parte del artefacto que se despliega.

### 4.3 Bucketizacion optima

Cada variable numerica se discretiza buscando los cortes que maximizan la
separacion respecto del objetivo, con restriccion de tamano minimo de bin
del cinco por ciento. De ahi sale el valor de informacion, que es la
metrica con la que se refinan las variables en la tercera etapa. El valor
de informacion detecta separacion no lineal que la correlacion no ve, y
penaliza a las variables cuya aparente importancia proviene de unos pocos
puntos extremos.

### 4.4 Variables derivadas de fisica

Entregarle al clasificador la distancia y la direccion del viento por
separado lo obliga a reconstruir por su cuenta una interaccion que ya se
conoce. Se codifican tres variables de forma explicita:

* Coseno del angulo entre el viento resultante de la ventana y la linea que
  une el lindero convencional con la parcela. Vale uno cuando el viento
  sopla directamente desde el vecino y cero cuando sopla en contra.
* Logaritmo de la distancia al lindero, que linealiza la caida de
  concentracion con el recorrido.
* Indice de exposicion, que combina alineamiento, distancia y velocidad en
  un solo numero con la forma del termino de transporte.

Es ingenieria de variables, no fuga: las tres se calculan con datos
disponibles antes de correr el kit. Conviene declarar la limitacion con
claridad: el indice de exposicion tiene la misma forma funcional que el
generador uso para simular la deriva, de modo que parte de su poder
predictivo es un artefacto del dato sintetico. Sobre datos reales su
desempeno seria menor. La forma de resolverlo no es quitar la variable,
porque la fisica que codifica es correcta, sino validar el modelo contra
resultados de laboratorio reales en cuanto existan.

## 5. Particion temporal

La particion es temporal y no aleatoria:

    entrenamiento   2,538 lotes   tasa 26.67 por ciento   hasta 2026 03 31
    calibracion     1,026 lotes   tasa 25.24 por ciento   2026 04 a 2026 06
    prueba            636 lotes   tasa 24.21 por ciento   desde 2026 07 01

Dos razones. Primera, un lote comparte finca con otros lotes de la misma
campana, de modo que una particion aleatoria dejaria lotes de la misma
finca a ambos lados y el modelo aprenderia la finca en vez del fenomeno.
Segunda, la particion temporal reproduce la unica forma en que el modelo se
usa de verdad: entrenado con lo que ya paso, aplicado a la cosecha que
viene.

Las 103 fincas del conjunto de prueba tambien aparecen en entrenamiento.
Esto es deliberado y correcto: en produccion se puntean lotes nuevos de
fincas ya conocidas, no fincas nuevas.

El conjunto intermedio cumple tres funciones: detener el entrenamiento por
parada temprana, ajustar el umbral operativo y ajustar la calibracion
isotonica. Ninguna de las tres puede decidirse sobre el conjunto de prueba
sin contaminar la estimacion.

## 6. Seleccion progresiva de variables en tres etapas

### 6.1 Configuracion del modelo

Se usa un clasificador de refuerzo por gradiente con configuracion
deliberadamente conservadora: profundidad maxima de tres, siete hojas,
minimo de ochenta observaciones por hoja, tasa de aprendizaje de 0.015 y
regularizacion L2 de diez. Con 2,538 filas de entrenamiento y una senal
parcialmente estocastica por construccion, un modelo profundo memoriza la
campana pasada y no generaliza.

### 6.2 Primer entrenamiento. Varianza y correlacion

Dos filtros estructurales. Se descartan las columnas de varianza nula y,
para cada par con correlacion absoluta sobre 0.90, se conserva la variable
con mayor correlacion con el objetivo.

Sobre este dataset ninguna variable cayo por varianza ni por correlacion, y
las 38 candidatas pasaron completas. El filtro se deja igualmente en el
pipeline porque su ausencia de efecto es un resultado de esta corrida, no
una propiedad garantizada del problema: al incorporar nuevas fuentes el
filtro volvera a tener trabajo.

Vale la pena registrar que si hay dos pares por encima de 0.80, que es el
umbral de reporte del analisis exploratorio: logaritmo de distancia con
distancia cruda, en 0.884, e indice de exposicion con coseno del viento, en
0.800. Quedaron por debajo del corte de 0.90 y ambos miembros de cada par
sobrevivieron.

Resultado sobre prueba: F1 de 0.5833, recall de 0.8182, AUC de 0.8353,
precision promedio de 0.6718, con 38 variables y 139 arboles.

### 6.3 Segundo entrenamiento. Valores SHAP

La importancia por ganancia que reporta el arbol favorece a las variables
de alta cardinalidad y depende del orden en que se hicieron los cortes. Los
valores SHAP reparten la prediccion entre las variables de forma aditiva y
consistente, y se calculan sobre el conjunto de calibracion y no sobre el
de entrenamiento, para que la importancia refleje generalizacion y no
memorizacion.

Se retiene el conjunto minimo que acumula el noventa y cinco por ciento de
la importancia total, que resulto en 13 variables de 38.

Las cuatro variables de mayor contribucion media absoluta:

* equipo compartido sin lavar, 0.2975. Es el cruce que dispara la Bernoulli
  de 0.8 del modelo fisico.
* coseno del viento hacia el lindero, 0.2451.
* indice de exposicion, 0.2311.
* sacos reutilizados, 0.1927.

El resultado tiene la propiedad que se buscaba con la recalibracion del
generador: las dos vias de contaminacion aparecen representadas en la cima
de la importancia, la operativa y la de deriva, y no una sola.

Resultado sobre prueba: F1 de 0.5659, recall de 0.7662, AUC de 0.8324, con
13 variables.

### 6.4 Tercer entrenamiento. Refinamiento numerico y categorico

La ultima etapa trata numericas y categoricas con criterios distintos,
porque el riesgo que corre cada grupo es distinto.

**Numericas.** Se conservan las que superan un valor de informacion de
0.02. Las trece numericas sobrevivientes de la etapa anterior lo superaron
todas, encabezadas por indice de exposicion en 0.6916, coseno del viento
hacia el lindero en 0.6423 y equipo compartido sin lavar en 0.3922.

**Categoricas.** Aqui la metrica no decide sola. Se cruza el valor de
informacion con un criterio de negocio y bioingenieria que responde a una
pregunta previa: existe un mecanismo fisico por el que esta variable pueda
causar la presencia de residuo en el grano.

El resultado del cruce fue instructivo y ninguna categorica entro al modelo
final:

* Identificador de tecnico. Mayor valor de informacion de todas, 0.0284.
  **Vetada por criterio de negocio.** Es un identificador de operador: el
  modelo aprenderia quien reporta y no que ocurre, y se rompe en cuanto
  rote el personal. Es el caso claro en que la metrica propone un atajo y
  el criterio de dominio lo bloquea.
* Empresa exportadora, variedad y destino previsto. Fuera por ambos
  criterios. Sin mecanismo fisico y con valor de informacion bajo. El
  destino previsto es ademas causalmente imposible: se asigna despues de la
  cosecha y no puede causar un residuo que ya estaba.
* Declaracion de fumigacion del vecino. **Fuera por metrica**, con valor de
  informacion de 0.0017, pese a tener el mecanismo causal mas directo de
  todas. Es la entrada explicita del modelo de deriva y aun asi no separa.

Este ultimo caso es el hallazgo mas util de la etapa. La interpretacion es
que la variable esta bien planteada pero mal capturada: una de cada cuatro
respuestas es no se sabe, y cuando el tecnico responde que si, la fecha de
la aplicacion es aproximada. La informacion causal existe, pero el
instrumento de captura la degrada hasta volverla ruido. La recomendacion
que se desprende no es descartar el dato sino mejorar su captura, con
georreferencia del lindero fumigado y fecha obligatoria, y volver a
evaluarla en la campana siguiente.

Resultado sobre prueba: F1 de 0.5803, recall de 0.7857, AUC de 0.8313, con
13 variables y solo 21 arboles.

### 6.5 Lectura honesta de las tres etapas

La seleccion progresiva no mejoro las metricas. El mejor AUC es el de la
primera etapa, 0.8353, y el modelo final llega a 0.8313. Conviene decirlo
tal cual en vez de presentar una mejora que no ocurrio.

Lo que si logro la seleccion es lo que se le pide a una seleccion de
variables:

* Reduccion de 38 a 13 variables, un sesenta y seis por ciento menos, con
  una perdida de AUC de 0.004, es decir medio punto porcentual relativo.
* El modelo final converge en 21 arboles frente a 139 del primero. Es
  sustancialmente mas barato de reentrenar y de puntear en el acopio.
* Las trece variables sobrevivientes tienen todas mecanismo fisico
  identificable, lo que hace defendible cada decision ante un auditor de
  certificacion. Un modelo que no se puede explicar no se puede usar para
  rechazar el lote de un productor.

## 7. Calibracion de probabilidades

### 7.1 Por que hace falta

El clasificador entrega un puntaje que ordena bien, pero ese puntaje no es
una probabilidad. Para la alerta del tablero basta con el orden, pero el
optimizador necesita probabilidades de verdad, porque su restriccion de
riesgo del contenedor se expresa como una probabilidad promedio y se
compara contra una tolerancia contractual. Si el puntaje sobreestima el
riesgo de forma sistematica, la restriccion rechaza lotes que podrian
haberse exportado.

### 7.2 Regresion isotonica

Se ajusta una funcion monotona por tramos que lleva el puntaje a la
frecuencia observada, sobre el conjunto de calibracion y nunca sobre el de
prueba. Al ser monotona por construccion preserva el ordenamiento, de modo
que no puede degradar la capacidad discriminante.

Resultados sobre el conjunto de prueba:

* Puntaje de Brier: 0.1643 sin calibrar contra 0.1308 calibrado, una mejora
  del 20.4 por ciento.
* Perdida logaritmica: 0.5062 contra 0.4281, una mejora del 15.4 por
  ciento.
* AUC: 0.8313 contra 0.8270.

La caida de AUC de 0.0043 requiere explicacion, porque una transformacion
monotona no deberia cambiarlo. El motivo es que la isotonica agrupa tramos
enteros de puntaje en un unico valor, y dentro de cada tramo desaparece el
orden que antes existia. Ese empate se resuelve arbitrariamente al calcular
el area bajo la curva y cuesta esos cuatro milesimos. Es el precio de
obtener probabilidades interpretables, y es un precio que vale la pena
pagar porque la restriccion del contenedor se expresa en probabilidades y
no en puntajes.

### 7.3 Umbral operativo

Con piso de recall del ochenta por ciento sobre calibracion, el umbral
elegido es 0.175. Sobre el conjunto de prueba:

* F1 de 0.5681, recall de 0.7987, precision de 0.4409.
* Matriz de confusion: 326 verdaderos negativos, 156 falsos positivos, 31
  falsos negativos, 123 verdaderos positivos.
* Se escapan 31 lotes contaminados de 154, el 20.1 por ciento.
* Se mandan a revision 156 lotes limpios de 482, el 32.4 por ciento.

La precision de 0.44 es baja en terminos absolutos y es una consecuencia
buscada. Con la asimetria de costos descrita, la alerta esta calibrada para
equivocarse por exceso de precaucion. Cada falso positivo cuesta la
diferencia de precio de un lote; cada falso negativo cuesta esa diferencia
mas el arrastre del contenedor mas el riesgo de certificacion.

## 8. Validacion por deciles

La curva de confiabilidad dice si las probabilidades son correctas en
promedio. El analisis por deciles responde la pregunta operativa: si la
cooperativa solo puede correr el panel completo sobre una parte de los
lotes, cuanta contaminacion real captura priorizando por puntaje.

Ordenando los 636 lotes de prueba de mayor a menor probabilidad y
partiendolos en diez grupos, la tasa observada por decil es 0.781, 0.492,
0.359, 0.190, 0.234, 0.143, 0.094, 0.064, 0.047 y 0.016.

Lecturas principales:

* Lift del primer decil de 3.23. El diez por ciento de lotes mas riesgoso
  concentra tres veces mas contaminacion que el promedio.
* Captura acumulada del 67.5 por ciento en los tres primeros deciles.
  Revisando el treinta por ciento de los lotes se detectan dos tercios de
  los contaminados. Es la cifra que sostiene el argumento operativo: con un
  presupuesto de kits limitado, priorizar por modelo triplica el
  rendimiento respecto de muestrear al azar.
* Estadistico de Kolmogorov Smirnov de 0.4953, que confirma separacion
  sustantiva entre las distribuciones de puntaje de lotes limpios y
  contaminados.
* Correspondencia entre probabilidad media predicha y tasa observada por
  decil: 0.897 contra 0.781 en el primero, 0.035 contra 0.016 en el
  ultimo.

**La monotonia no es estricta.** Hay una inversion, entre el cuarto decil
con tasa observada de 0.190 y el quinto con 0.234. Se reporta en vez de
suavizarse porque es informacion util: en la zona media, con probabilidades
entre 0.13 y 0.19, el modelo separa lo suficiente para el objetivo, pero no
ordena con finura. La implicacion practica es que no conviene tomar
decisiones que dependan de distinguir el cuarto decil del quinto. La
decision binaria de segregar, que es la que se toma, no depende de esa
distincion.

## 9. Modelo multietiqueta por agroquimico

El modelo anterior responde si el lote esta contaminado. Este responde por
cual de los cuatro kits, que es una pregunta con valor propio: si el
sistema anticipa que el riesgo viene del herbicida y no del fungicida, la
cooperativa corre primero ese kit y aplaza los otros tres.

Se envuelve un clasificador por etiqueta sobre las mismas trece variables
finales. Resultados sobre prueba, con prevalencia, F1 y AUC:

* Glifosato. Prevalencia 0.080, F1 de 0.694, recall de 0.667, AUC de 0.927.
* Clorpirifos. Prevalencia 0.093, F1 de 0.365, recall de 0.322, AUC de
  0.761.
* Cipermetrina. Prevalencia 0.118, F1 de 0.333, recall de 0.520, AUC de
  0.771.
* Carbendazim. Prevalencia 0.017, F1 de 0.500, recall de 0.364, AUC de
  0.930.

Una decision de diseno merece explicacion. Los umbrales de este modelo se
eligen maximizando F1 sin piso de recall, a diferencia del modelo binario.
La razon es que este modelo no decide si un lote pasa o no: ordena que kit
conviene correr primero. Para esa tarea manda la calidad del ordenamiento,
que mide el AUC, y forzar el piso de recall hundiria la precision sin
mejorar la decision que realmente se toma.

La lectura util esta en el AUC y no en el F1. Glifosato y carbendazim se
ordenan muy bien, por encima de 0.92, porque su contaminacion viene
dominada por la via de deriva, que el modelo observa a traves de la
geometria y el viento. Clorpirifos y cipermetrina se ordenan peor, cerca de
0.77, porque su contaminacion depende mas de la via operativa, que tiene un
componente Bernoulli irreducible: el modelo puede saber que el equipo se
compartio sin lavar, pero no si en esa ocasion particular el residuo se
transfirio.

El F1 bajo de clorpirifos y cipermetrina es consecuencia directa de esa
diferencia y de sus prevalencias de un digito. Se reporta como limitacion,
no como resultado: el modelo multietiqueta sirve hoy para ordenar el gasto
de kits, no para reemplazar ningun kit.

## 10. Modelo de optimizacion entera mixta

### 10.1 Formulacion

**Variable de decision.** Una binaria por lote. Vale uno si el lote va a
exportacion organica y cero si se segrega a mercado convencional.

**Funcion objetivo.** Se maximiza

    suma sobre i de  X_i por w_i por ((V_org menos V_conv) menos lambda por P(C_i))

donde w_i son los quintales del lote, V_org y V_conv son los precios por
quintal en cada canal, P(C_i) es la probabilidad calibrada de
contaminacion, y lambda es el costo por unidad de probabilidad. El ingreso
de un lote segregado no es cero, se vende igual a menor precio, de modo que
el termino constante correspondiente sale del objetivo del solver y se
vuelve a sumar al reportar el valor total.

Con V_org de 210 dolares por quintal, V_conv de 160 y lambda de 260, el
punto de indiferencia queda en una probabilidad de 50 sobre 260, es decir
0.192. Por encima de esa probabilidad un lote no compensa exportarlo ni
siquiera si hubiera espacio de riesgo disponible.

**Restriccion de riesgo del contenedor.** La probabilidad media de
contaminacion de lo exportado, ponderada por volumen, no puede superar la
tolerancia alfa:

    suma sobre i de  X_i por w_i por (P(C_i) menos alfa)  menor o igual a cero

Se pondera por quintales porque un lote grande contaminado compromete mas
carga que uno pequeno. Escrita asi la restriccion es lineal y no hay que
linealizar ningun cociente, que es el error habitual al implementar esta
formulacion.

**Restriccion de cuarentena espacial.** Si una finca resulta foco, con
probabilidad maxima sobre 0.80, sus fincas vecinas dentro de un radio de
ochocientos metros quedan excluidas aunque su propia probabilidad sea baja.
Es la regla de buffer: la deriva no respeta linderos y una parcela limpia
rodeada de aplicacion es una parcela en riesgo que todavia no se midio. La
vecindad se calcula con distancia sobre la esfera a partir de las
coordenadas de finca.

### 10.2 Resultados

Sobre los 636 lotes de inferencia, con tolerancia de 0.05:

* Estado del solver: optimo.
* Se exportan 270 lotes de 636, equivalentes a 37,340 quintales de 90,733.
* 132 lotes quedan bloqueados por cuarentena espacial, correspondientes a
  19 fincas, de las cuales 13 son focos y 6 son vecinas arrastradas.
* Riesgo ponderado del contenedor realizado: 0.0500. La restriccion queda
  activa exactamente en el limite, que es lo esperado cuando la tolerancia
  es el factor limitante.
* Se embarcan 15 lotes que en realidad estaban contaminados, el 5.56 por
  ciento de lo exportado, coherente con la tolerancia declarada.
* Se segregan correctamente 139 lotes contaminados.

El reparto de motivos de segregacion es util para el supervisor: 132 lotes
por cuarentena espacial, 141 por no romper la tolerancia agregada del
contenedor y 93 porque su riesgo esperado individual supera la diferencia
de precio. Cada fila del archivo de decisiones lleva su motivo, de modo que
la decision se puede defender lote por lote.

### 10.3 Frontera de tolerancia

La tolerancia no es un dato tecnico sino una clausula comercial, asi que se
recorre:

* Con tolerancia de 0.01, 0.02 y 0.03 el modelo no exporta nada. No existe
  ningun subconjunto de lotes cuyo riesgo medio ponderado baje de esos
  niveles. Es un resultado y no una falla: dice que la tolerancia del uno
  por ciento que suele citarse como referencia no es alcanzable con la
  calidad de prediccion actual, y que negociarla o mejorar el modelo son
  las dos unicas salidas.
* Con 0.05 se colocan 37,340 quintales y escapan 15 lotes contaminados.
* Con 0.08 se colocan 48,672 quintales y escapan 33.
* Con 0.12 se colocan 57,938 quintales y escapan 46. A partir de ahi la
  restriccion de riesgo deja de estar activa y manda la economia de cada
  lote: subir la tolerancia a 0.20 no cambia nada porque ya nadie mas
  compensa.

### 10.4 Valoracion economica

La comparacion de politicas exige cuidado con el costo, y este es el punto
donde una primera version del analisis daba un resultado equivocado.

Valorando solo con la penalizacion de cincuenta dolares por quintal, la
politica de exportar todo sin filtrar ganaba. El motivo es aritmetico: la
penalizacion coincide exactamente con la prima organica, de modo que
exportar un quintal contaminado deja lo mismo que venderlo como
convencional y filtrar no aporta nada. Con ese costo el proyecto entero no
se justifica.

Lo que hace cara la contaminacion no es la penalizacion visible sino lo que
arrastra. El costo pleno por quintal contaminado embarcado se descompone
asi:

* Cincuenta dolares de penalizacion directa en destino.
* Ciento treinta dolares de arrastre sobre el contenedor. Un lote medio
  ocupa cerca de la mitad de un contenedor, de modo que cada quintal
  contaminado degrada aproximadamente dos quintales de cafe limpio
  consolidado junto a el.
* Ochenta dolares de riesgo de certificacion amortizado, que cubre
  auditoria extraordinaria y suspension temporal del sello.

La suma es 260 dolares por quintal, que es exactamente el lambda de la
funcion objetivo. Que la evaluacion y la decision compartan el costo no es
un detalle de implementacion: valorar un plan con un costo distinto del que
se uso para construirlo produce una comparacion que no significa nada. El
notebook lo verifica con una asercion explicita.

Con ese costo, sobre los 636 lotes de inferencia:

* Todo a convencional: 14,517,264 dolares de valor neto.
* Todo a organico sin filtro: 13,426,885 dolares. Embarca 21,642 quintales
  contaminados y termina por debajo de vender todo como convencional.
* Plan del optimizador: 15,903,758 dolares. Embarca 1,848 quintales
  contaminados.

El plan aporta 1,386,494 dolares sobre la politica de vender todo como
convencional y 2,476,873 dolares sobre exportar todo sin filtrar. Evita que
19,794 quintales contaminados lleguen al contenedor.

**Analisis de indiferencia.** El plan supera a exportar todo sin filtrar
cuando el costo por quintal contaminado supera los 135 dolares. Por debajo
de esa cifra conviene exportar todo y absorber la penalizacion. La
conclusion practica es que la justificacion economica del proyecto no
descansa en la penalizacion de cincuenta dolares por quintal, que por si
sola no alcanza, sino en el arrastre sobre el contenedor y en el riesgo de
certificacion. Cualquier presentacion del caso de negocio que se apoye solo
en la cifra de la penalizacion esta construida sobre una base que no
soporta el analisis.

### 10.5 Conexion del optimizador con el tablero

El modelo de optimizacion no se queda en el notebook. El tablero incorpora
una implementacion equivalente en javascript, de modo que el supervisor ve
el plan de segregacion en la misma pantalla donde ve la alerta, con el
motivo de cada decision y sin depender de que haya un servidor de modelos
detras. El modulo vive en js/modules/optimizer.js y funciona incluso
abriendo el tablero con doble clic, sin servidor.

**El navegador resuelve el mismo problema, no una aproximacion.** La
formulacion de la seccion 10.1 tiene coeficientes de riesgo negativos para
los lotes cuya probabilidad esta por debajo de la tolerancia, de modo que
no es una mochila binaria estandar. La sustitucion y sub i igual a uno
menos x sub i sobre ese subconjunto normaliza los pesos a valores no
negativos y deja una mochila binaria exacta, que se resuelve por
programacion dinamica sobre la capacidad discretizada en veinte mil pasos.
El script scripts/verificar_optimizador.py corre el modulo bajo node y
compara el valor objetivo contra PuLP con CBC en cuarenta escenarios, entre
ellos dieciocho de estres con tolerancias altas que fuerzan la rama de
sustitucion. La peor brecha relativa observada es 2.6 por diez elevado a
menos dieciseis, que es ruido de punto flotante. La geometria de haversine
coincide con la version en python por debajo de un micrometro.

**De donde sale la probabilidad de cada lote.** El tablero no lleva el
modelo entrenado, porque no hay interprete de python del otro lado. Usa una
jerarquia de cuatro origenes, que la tarjeta de cada lote declara de forma
explicita:

* medido. El panel encontro un residuo sobre el umbral. La probabilidad es
  uno, no una estimacion.
* panel cerrado. Los cuatro kits se corrieron y ninguno excedio. La
  probabilidad es la sensibilidad residual del ensayo, fijada en 0.02 como
  supuesto de dominio documentado.
* prior. Quedan kits pendientes. Se usa la probabilidad empirica conjunta
  de que al menos uno de los agroquimicos faltantes exceda, condicionada al
  grupo de proximidad de la finca. El script scripts/calcular_priors.py
  calcula esas probabilidades sobre los datos de entrenamiento para los
  quince subconjuntos no vacios del panel y las guarda en
  data/priors_riesgo.json. Se usa la conjunta y no el producto de
  marginales porque los excesos estan correlacionados entre agroquimicos:
  suponer independencia sobreestima el riesgo en 23.2 por ciento en el
  grupo de proximidad alta y en 8.7 por ciento en el de proximidad baja.
* fuera de alcance. El lote no es organico, de modo que no entra al
  problema de asignacion y se comercializa por el canal convencional.

**La cuarentena en el tablero aplica una jerarquia de evidencia que el
notebook no aplica.** Esta diferencia es deliberada y conviene dejarla
escrita. En el notebook la cuarentena es una regla de finca: toda finca a
menos de ochocientos metros de un foco queda bloqueada. En el tablero la
regla se separa en dos casos:

* Finca foco, con contaminacion confirmada en sitio. Todos sus lotes quedan
  bloqueados, sin excepcion.
* Finca colindante. Solo quedan bloqueados los lotes cuyo panel sigue
  abierto. Un lote con panel cerrado y conforme queda exento del bloqueo
  por colindancia.

La geometria de la cuarentena se calcula siempre sobre la cartera completa,
nunca sobre el subconjunto que los filtros del mapa dejan visible. La
colindancia con un foco es un hecho del territorio, y si se calculara sobre
lo visible, filtrar por exportadora o por destino hasta ocultar la finca foco
levantaria el bloqueo de sus colindantes. Ese es el camino por el que un
filtro de lectura se convierte en una falla de contencion, y el tablero lo
cierra pasando la cartera completa como universo de la cuarentena mientras
optimiza solo sobre lo visible.

El motivo de la exencion por panel cerrado es que la proximidad es un
sustituto de una contaminacion que no se observo. Cuando el desenlace que ese sustituto predice ya se midio de
forma directa y dio conforme, el sustituto no agrega informacion y solo
quita valor. El notebook se queda con la regla simple porque en el conjunto
de inferencia sintetico la cobertura del panel es parcial y el caso de
panel cerrado es minoritario. En el tablero es el caso mayoritario, y la
regla simple producia un plan degenerado: cero lotes exportados en toda
tolerancia por debajo de veinte por ciento, porque dos lotes con panel
completo y conforme quedaban bloqueados por vecindad. La finca foco sigue
bloqueada por completo, de modo que la regla no debilita la contencion
donde si hay evidencia de contaminacion.

**Lo que muestra el tablero.** Sobre la cartera de demostracion de siete
lotes, con tolerancia de cinco por ciento, el plan exporta tres lotes y 445
quintales con riesgo ponderado de 0.0476, segrega cuatro lotes a
convencional y aporta 16,741 dolares sobre vender todo como convencional.
Dos fincas quedan como foco, dos como colindantes y dos lotes quedan
exentos por panel cerrado. El selector de tolerancia recalcula el plan
completo en el navegador y deja ver la frontera: con uno por ciento no hay
embarque viable, con tres por ciento entran los dos lotes de panel cerrado
y con cinco por ciento entra ademas el lote de riesgo intermedio. El plan
se descarga como CSV con una fila por lote, su probabilidad, su origen, su
decision y su motivo.

## 11. Reproducibilidad

Toda la corrida es determinista bajo la semilla 20260829. La secuencia
completa es:

    python3 scripts/generar_data_sintetica.py
    jupyter execute --inplace notebooks/pipeline_ml_optimizacion.ipynb

Artefactos que quedan en resultados:

* resumen_ejecucion.json con las cifras principales de la corrida.
* modelo/artefacto_cafetrace.joblib con el clasificador, el calibrador
  isotonico, el escalador, el mapeo de categorias, la lista de variables y
  el umbral operativo.
* modelo/variables_seleccionadas.json con las variables de cada etapa y las
  descartadas, con su motivo.
* modelo/metricas_por_etapa.csv, metricas_calibracion.csv,
  analisis_deciles.csv, metricas_multietiqueta.csv, importancia_shap.csv y
  los dos archivos de valor de informacion.
* optimizacion/decisiones_por_lote.csv con la decision, el motivo y el
  valor asignado a cada uno de los 636 lotes de inferencia.
* optimizacion/frontera_tolerancia.csv, comparacion_politicas.csv y
  sensibilidad_costo.csv.
* Doce figuras en eda, modelo y optimizacion.

## 12. Limitaciones

Se enumeran las que un revisor deberia preguntar antes de que las
pregunte.

**Los datos son sinteticos.** Todas las cifras de desempeno son
condicionales a que el generador reproduzca la fisica real. El indice de
exposicion comparte forma funcional con el proceso generador, de modo que
sobre datos reales su poder predictivo seria menor. Ninguna metrica de este
informe debe presentarse como desempeno esperado en campo sin validacion
contra resultados de laboratorio reales.

**El componente operativo es irreducible por construccion.** La
contaminacion cruzada por equipo se modela como una Bernoulli. Ningun
modelo puede predecir el resultado de un lanzamiento de moneda, solo su
probabilidad. Eso pone un techo al AUC alcanzable que no depende de la
calidad del modelo, y explica por que clorpirifos y cipermetrina se ordenan
peor que glifosato y carbendazim.

**Una sola particion temporal.** No hay validacion cruzada temporal en
ventanas moviles. Con 636 lotes de prueba los intervalos de confianza de F1
son amplios, del orden de mas menos cinco puntos. Las diferencias de cuatro
milesimos de AUC entre etapas no son estadisticamente distinguibles y no se
deben leer como tales.

**La tolerancia y el lambda son supuestos.** Alfa de 0.05 y lambda de 260
no provienen de contratos reales sino de una descomposicion razonada. El
analisis de indiferencia y la frontera de tolerancia estan justamente para
que esos dos numeros se puedan renegociar sin rehacer el trabajo.

**La cuarentena espacial usa distancia entre centroides de finca.** No usa
la geometria real de los poligonos ni la direccion del viento entre finca
foco y finca vecina. Una version posterior deberia usar la capa de
poligonos y ponderar la vecindad por alineamiento con el viento dominante,
que es informacion que el sistema ya captura.

**La declaracion de fumigacion no es usable hoy.** Tiene el mecanismo
causal mas directo y el valor de informacion mas bajo. Antes de volver a
evaluarla hace falta cambiar como se captura en campo.

## 13. Trabajo siguiente

El punto que estaba en esta lista sobre conectar el optimizador al tablero
quedo resuelto y se documenta en la seccion 10.5.

Ordenado por relacion entre valor y esfuerzo:

1. Mejorar la captura de la declaracion de fumigacion en el cuaderno de
   campo: georreferencia del lindero fumigado y fecha obligatoria en vez de
   respuesta libre. Es la unica variable con mecanismo causal directo que
   hoy se pierde por instrumento.
2. Validar contra resultados de laboratorio reales en cuanto exista una
   campana completa, y recalibrar la isotonica sobre esos datos.
3. Sustituir la distancia entre centroides por la geometria de poligonos y
   ponderar la vecindad de cuarentena por alineamiento con el viento.
4. Validacion cruzada temporal en ventanas moviles, para acompanar cada
   metrica con un intervalo en vez de un punto.
5. Unificar la regla de cuarentena entre el notebook y el tablero. Hoy el
   tablero aplica la jerarquia de evidencia descrita en la seccion 10.5 y el
   notebook la regla simple de finca. La del tablero es la correcta y el
   notebook deberia adoptarla en cuanto el conjunto de inferencia tenga
   cobertura de panel suficiente para que la diferencia se note en las
   cifras.
6. Sustituir los priors empiricos del tablero por el modelo entrenado
   servido desde el backend, en cuanto la arquitectura deje de ser local.
   Los priors condicionados por grupo de proximidad son un sustituto
   razonable, pero pierden toda la senal de las variables de finca y clima
   que el modelo si usa.
