/* ==========================================================================
   CafeTrace · modules/map-risk.js
   --------------------------------------------------------------------------
   Mapa de Riesgo Geografico.

   Mapa coropletico del Peru en proyeccion Mercator (d3.geoMercator) sobre el
   que se pintan las fincas. La proyeccion se ajusta con fitExtent al bounding
   box de los limites departamentales, asi que el encuadre es siempre el Peru
   y solo el Peru: no aparece el resto de Sudamerica.

   Problema de escala y como se resuelve:
     Las fincas de una cooperativa caben en ~0.03 grados (unos 3 km). A escala
     nacional (~12.7 grados) serian un solo pixel. Por eso el mapa agrupa:
       - Alejado (k < UMBRAL_CLUSTER): un marcador agregado por zona de acopio,
         dimensionado por el total de quintales y coloreado por el peor riesgo.
       - Acercado: el agregado se abre en las fincas individuales.
     Es el mismo comportamiento de cualquier mapa con clustering, y evita el
     mapa "vacio" al que llevaria un zoom fijo.

   Codificacion visual:
     - Posicion  -> coordenadas reales proyectadas en Mercator.
     - Area      -> Peso_Quintales del lote (escala sqrt: area, no radio).
     - Color     -> nivel de riesgo del motor de reglas.
     - Forma     -> circulo = finca organica; rombo = finca convencional.
     - Linea     -> vector de deriva potencial hacia la convencional mas
                    cercana (solo fincas organicas de proximidad Alta).
     - Relleno del departamento -> resaltado el que concentra el acopio.

   Los marcadores se contra-escalan por 1/k en cada zoom para conservar su
   tamano en pantalla: si escalaran con el mapa, al acercarse taparian todo.
   ========================================================================== */
(function (global) {
  'use strict';

  var CT = (global.CT = global.CT || {});

  var MARGEN = 14;

  // Factor de zoom a partir del cual el agregado se abre en fincas sueltas.
  var UMBRAL_CLUSTER = 25;

  // d3.symbolDiamond con area A tiene semi-diagonal vertical sqrt(A/1.1547).
  // Con A = PI*r^2 eso da ~1.65*r: el rombo es mas alto que el circulo del
  // mismo radio, y hay que tenerlo en cuenta al posicionar su etiqueta.
  var ALTO_ROMBO = 1.65;

  // Paleta semaforo compartida con el resto de la UI (ver styles.css).
  var COLORES = {
    Critico: '#c0392b',
    Alto: '#e2571e',
    Medio: '#e0a80b',
    Bajo: '#3f8f5f',
    'No aplica': '#8d8d84'
  };

  var SEVERIDAD = { Critico: 4, Alto: 3, Medio: 2, Bajo: 1, 'No aplica': 0 };

  function colorDe(riesgo) {
    return COLORES[riesgo] || COLORES['No aplica'];
  }

  function peorRiesgo(registros) {
    return registros.reduce(function (peor, r) {
      return (SEVERIDAD[r.Riesgo] || 0) > (SEVERIDAD[peor] || 0) ? r.Riesgo : peor;
    }, 'Bajo');
  }

  /**
   * @param {string} selector  Contenedor CSS donde montar el SVG.
   * @param {Object} opciones  { onSelect: fn(registro) }
   */
  function crear(selector, opciones) {
    opciones = opciones || {};

    var contenedor = d3.select(selector);
    var geo = global.CT_PERU_GEO || null;
    var datos = [];
    var seleccionado = null;
    var kActual = 1;
    var depAcopio = null; // departamento que concentra las fincas

    if (!geo) {
      console.error(
        '[CafeTrace] Falta data/peru-departamentos.js: el mapa no puede dibujarse.'
      );
      contenedor
        .append('p')
        .attr('class', 'ct-empty')
        .text('No se pudo cargar la geometria del Peru (data/peru-departamentos.js).');
      return { actualizar: function () {}, seleccionar: function () {}, colorDe: colorDe };
    }

    var tooltip = d3
      .select('body')
      .append('div')
      .attr('class', 'ct-tooltip')
      .style('opacity', 0);

    /* ------------------------------------------------------------------
       Barra de vistas
       ------------------------------------------------------------------ */
    var barra = contenedor.append('div').attr('class', 'ct-mapa-barra');

    var svg = contenedor.append('svg').attr('class', 'ct-svg ct-mapa');
    var gZoom = svg.append('g').attr('class', 'ct-zoom');
    var gDeps = gZoom.append('g').attr('class', 'ct-deps');
    var gRetic = gZoom.append('g').attr('class', 'ct-reticula');
    var gDeriva = gZoom.append('g').attr('class', 'ct-deriva');
    var gPuntos = gZoom.append('g').attr('class', 'ct-puntos');
    var gEscala = svg.append('g').attr('class', 'ct-escala'); // fuera del zoom

    var proyeccion = d3.geoMercator();
    var camino = d3.geoPath(proyeccion);

    var zoom = d3
      .zoom()
      .scaleExtent([1, 3000])
      .on('zoom', function (evento) {
        gZoom.attr('transform', evento.transform);
        var kPrevio = kActual;
        kActual = evento.transform.k;

        // Solo repintamos marcadores al cruzar el umbral de agrupacion;
        // en el resto del zoom basta con contra-escalar lo ya dibujado.
        var cruzo =
          (kPrevio < UMBRAL_CLUSTER) !== (kActual < UMBRAL_CLUSTER);
        if (cruzo) pintarMarcadores();
        else contraEscalar();

        pintarReticula();
        pintarEscala();
      });

    svg.call(zoom);

    /* ------------------------------------------------------------------
       Vistas predefinidas
       ------------------------------------------------------------------ */
    function bboxDe(features) {
      return d3.geoBounds({ type: 'FeatureCollection', features: features });
    }

    /** Calcula y aplica la transformacion que encuadra un bbox geografico. */
    function irA(bbox, ms) {
      var nodo = contenedor.node();
      var w = anchoUtil(nodo);
      var h = altoUtil();

      var p0 = proyeccion([bbox[0][0], bbox[1][1]]); // esquina sup-izq
      var p1 = proyeccion([bbox[1][0], bbox[0][1]]); // esquina inf-der
      if (!p0 || !p1) return;

      var dx = Math.abs(p1[0] - p0[0]) || 1;
      var dy = Math.abs(p1[1] - p0[1]) || 1;
      var cx = (p0[0] + p1[0]) / 2;
      var cy = (p0[1] + p1[1]) / 2;

      var k = Math.min(3000, Math.max(1, 0.82 * Math.min(w / dx, h / dy)));

      svg
        .transition()
        .duration(ms === undefined ? 650 : ms)
        .call(
          zoom.transform,
          d3.zoomIdentity.translate(w / 2, h / 2).scale(k).translate(-cx, -cy)
        );
    }

    function bboxFincas() {
      var lons = datos.map(function (d) { return d.lon; });
      var lats = datos.map(function (d) { return d.lat; });
      // Margen de ~0.012 grados (~1.3 km) para que los marcadores respiren.
      var m = 0.012;
      return [
        [d3.min(lons) - m, d3.min(lats) - m],
        [d3.max(lons) + m, d3.max(lats) + m]
      ];
    }

    var VISTAS = [
      { id: 'peru', etiqueta: 'Peru', fn: function () { irA(bboxDe(geo.features)); } },
      {
        id: 'dep',
        etiqueta: 'Departamento',
        fn: function () {
          if (depAcopio) irA(bboxDe([depAcopio]));
        }
      },
      {
        id: 'acopio',
        etiqueta: 'Zona de acopio',
        fn: function () {
          if (datos.length) irA(bboxFincas());
        }
      }
    ];

    VISTAS.forEach(function (v, i) {
      barra
        .append('button')
        .attr('type', 'button')
        .attr('class', 'ct-chip' + (i === 0 ? ' is-active' : ''))
        .attr('data-vista', v.id)
        .text(v.etiqueta)
        .on('click', function () {
          barra.selectAll('button').classed('is-active', function () {
            return this.getAttribute('data-vista') === v.id;
          });
          v.fn();
        });
    });

    barra
      .append('span')
      .attr('class', 'ct-mapa-hint')
      .text('Rueda para acercar · arrastra para desplazar');

    /* ------------------------------------------------------------------
       Vectores de deriva: para cada finca organica con proximidad Alta,
       la finca convencional mas cercana. Modelado de riesgo espacial por
       proximidad, en su version minima.
       ------------------------------------------------------------------ */
    function calcularVectoresDeriva(registros) {
      var convencionales = registros.filter(function (r) {
        return r.Certificacion_Declarada === 'Convencional';
      });
      if (!convencionales.length) return [];

      return registros
        .filter(function (r) {
          return (
            r.Certificacion_Declarada === 'Organico' &&
            r.Proximidad_Finca_Convencional === 'Alta'
          );
        })
        .map(function (r) {
          var masCercana = convencionales.reduce(function (mejor, c) {
            var d = Math.hypot(c.lon - r.lon, c.lat - r.lat);
            return !mejor || d < mejor.dist ? { finca: c, dist: d } : mejor;
          }, null);
          return { origen: r, destino: masCercana.finca, dist: masCercana.dist };
        });
    }

    /* ------------------------------------------------------------------
       Tooltips
       ------------------------------------------------------------------ */
    function contenidoFinca(r) {
      var ppm =
        r.Glifosato_ppm === null
          ? '<span class="ct-tt-warn">sin test ELISA</span>'
          : r.Glifosato_ppm.toFixed(2) + ' ppm';

      return (
        '<div class="ct-tt-head" style="border-color:' + colorDe(r.Riesgo) + '">' +
        '<strong>' + r.Finca + '</strong>' +
        '<span class="ct-badge" style="background:' + colorDe(r.Riesgo) + '">' +
        r.Riesgo + '</span></div>' +
        '<dl class="ct-tt-body">' +
        '<dt>Productor</dt><dd>' + r.Nombre + ' · ' + r.ID_Productor + '</dd>' +
        '<dt>Certificacion</dt><dd>' + r.Certificacion_Declarada +
        ' <em>(proximidad ' + r.Proximidad_Finca_Convencional + ')</em></dd>' +
        '<dt>Glifosato</dt><dd>' + ppm + '</dd>' +
        '<dt>Coordenadas</dt><dd>' + r.lat.toFixed(4) + ', ' + r.lon.toFixed(4) + '</dd>' +
        '<dt>Lote</dt><dd>' + r.ID_Lote + ' · ' + r.Peso_Quintales +
        ' qq · ' + r.Destino + '</dd>' +
        '<dt>Accion</dt><dd>' + r.Accion + '</dd>' +
        '</dl>' +
        '<div class="ct-tt-foot">Clic para abrir el pasaporte de trazabilidad</div>'
      );
    }

    function contenidoCluster(c) {
      var criticos = c.registros.filter(function (r) { return r.Segregado; }).length;
      var sinTest = c.registros.filter(function (r) {
        return r.Certificacion_Declarada === 'Organico' && !r.ID_Test;
      }).length;

      return (
        '<div class="ct-tt-head" style="border-color:' + colorDe(c.riesgo) + '">' +
        '<strong>' + c.dep + '</strong>' +
        '<span class="ct-badge" style="background:' + colorDe(c.riesgo) + '">' +
        c.riesgo + '</span></div>' +
        '<dl class="ct-tt-body">' +
        '<dt>Fincas</dt><dd>' + c.registros.length + '</dd>' +
        '<dt>Volumen</dt><dd>' + d3.format(',')(c.quintales) + ' quintales</dd>' +
        '<dt>Criticos</dt><dd>' + criticos + ' lote(s) para segregar</dd>' +
        '<dt>Sin testear</dt><dd>' + sinTest + ' lote(s) organico(s)</dd>' +
        '</dl>' +
        '<div class="ct-tt-foot">Clic para acercar a la zona de acopio</div>'
      );
    }

    function mostrarTooltip(html, evento) {
      tooltip.html(html).transition().duration(120).style('opacity', 1);
      moverTooltip(evento);
    }

    function moverTooltip(evento) {
      var ancho = 320;
      var x = Math.min(evento.pageX + 16, global.innerWidth - ancho - 12);
      var y = evento.pageY + 16;
      tooltip.style('left', x + 'px').style('top', y + 'px');
    }

    function ocultarTooltip() {
      tooltip.transition().duration(160).style('opacity', 0);
    }

    /* ------------------------------------------------------------------
       Dimensiones
       ------------------------------------------------------------------ */
    function anchoUtil(nodo) {
      return Math.max((nodo || contenedor.node()).clientWidth, 300) - MARGEN * 2;
    }

    function altoUtil() {
      // El mapa del Peru es marcadamente vertical (~18 grados de latitud por
      // ~12.7 de longitud): un lienzo apaisado desperdiciaria la mitad.
      var nodo = contenedor.node();
      var w = anchoUtil(nodo);
      return Math.max(380, Math.min(w * 1.35, 660));
    }

    /* ------------------------------------------------------------------
       Referencias cartograficas: reticula y barra de escala.
       A zoom cerrado no hay limites politicos visibles y el mapa quedaria
       como un fondo plano sin referencia. La reticula da orientacion y la
       barra de escala da la magnitud, que es justamente lo que sostiene el
       argumento de deriva: "esta finca esta a X km de una convencional".
       ------------------------------------------------------------------ */
    var PASOS_RETICULA = [10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01,
                          0.005, 0.002, 0.001];

    // Techo de lineas por eje. d3.geoGraticule cubre TODO el globo por
    // defecto: con paso 0.01 serian ~36,000 meridianos y el navegador se
    // cuelga. Acotamos la reticula a la ventana visible y ademas limitamos
    // cuantas lineas puede generar.
    var MAX_LINEAS = 60;

    /** Ventana geografica visible [[lonMin,latMin],[lonMax,latMax]]. */
    function extentVisible() {
      var w = anchoUtil();
      var h = altoUtil();
      var t = d3.zoomTransform(svg.node());

      var esquinas = [
        proyeccion.invert(t.invert([MARGEN, MARGEN])),
        proyeccion.invert(t.invert([w + MARGEN, MARGEN])),
        proyeccion.invert(t.invert([MARGEN, h + MARGEN])),
        proyeccion.invert(t.invert([w + MARGEN, h + MARGEN]))
      ].filter(function (p) {
        return p && isFinite(p[0]) && isFinite(p[1]);
      });

      if (esquinas.length < 4) return bboxDe(geo.features); // fallback: Peru

      var lons = esquinas.map(function (p) { return p[0]; });
      var lats = esquinas.map(function (p) { return p[1]; });
      return [
        [d3.min(lons), Math.max(d3.min(lats), -89)],
        [d3.max(lons), Math.min(d3.max(lats), 89)]
      ];
    }

    /** Paso en grados tal que las lineas queden a ~90 px y no excedan el techo. */
    function pasoReticula(ext) {
      var w = anchoUtil();
      var gradosVisibles = Math.max(ext[1][0] - ext[0][0], 1e-6);
      var objetivo = (gradosVisibles * 90) / Math.max(w, 1);

      for (var i = 0; i < PASOS_RETICULA.length; i++) {
        var paso = PASOS_RETICULA[i];
        if (paso > objetivo) continue;
        if (gradosVisibles / paso <= MAX_LINEAS) return paso;
      }
      // Ningun paso de la tabla sirve (zoom extremo): repartimos la ventana
      // en ~8 lineas. Antes esto devolvia el paso mas GRUESO (10 grados) y la
      // reticula desaparecia justo en la vista de acopio.
      return gradosVisibles / 8;
    }

    function pintarReticula() {
      var ext = extentVisible();
      var paso = pasoReticula(ext);

      // Un margen de una celda evita que las lineas del borde desaparezcan
      // al desplazar el mapa.
      var g = d3
        .geoGraticule()
        .extent([
          [ext[0][0] - paso, Math.max(ext[0][1] - paso, -89)],
          [ext[1][0] + paso, Math.min(ext[1][1] + paso, 89)]
        ])
        .step([paso, paso]);

      gRetic
        .selectAll('path')
        .data([g()])
        .join('path')
        .attr('class', 'ct-graticula')
        .attr('d', camino);
    }

    /** Distancia en km entre dos pares [lon, lat]. */
    function km(a, b) {
      return d3.geoDistance(a, b) * 6371;
    }

    var ESCALAS_KM = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];

    function pintarEscala() {
      var w = anchoUtil();
      var h = altoUtil();
      var t = d3.zoomTransform(svg.node());
      var cx = (w + MARGEN * 2) / 2;
      var cy = (h + MARGEN * 2) / 2;

      var a = proyeccion.invert(t.invert([cx - 50, cy]));
      var b = proyeccion.invert(t.invert([cx + 50, cy]));
      if (!a || !b) return;

      var kmPor100px = km(a, b);
      if (!isFinite(kmPor100px) || kmPor100px <= 0) return;

      // Elegimos la distancia redonda cuya barra mida entre 60 y 160 px.
      var elegida = ESCALAS_KM[0];
      for (var i = 0; i < ESCALAS_KM.length; i++) {
        var px = (ESCALAS_KM[i] / kmPor100px) * 100;
        if (px >= 60 && px <= 160) { elegida = ESCALAS_KM[i]; break; }
        if (px < 60) elegida = ESCALAS_KM[i];
      }
      var anchoBarra = (elegida / kmPor100px) * 100;

      gEscala.selectAll('*').remove();
      gEscala.attr('transform', 'translate(' + (MARGEN + 12) + ',' + (h - 10) + ')');

      gEscala.append('line')
        .attr('class', 'ct-escala-linea')
        .attr('x1', 0).attr('y1', 0).attr('x2', anchoBarra).attr('y2', 0);
      [0, anchoBarra].forEach(function (x) {
        gEscala.append('line')
          .attr('class', 'ct-escala-linea')
          .attr('x1', x).attr('y1', -5).attr('x2', x).attr('y2', 5);
      });
      gEscala.append('text')
        .attr('class', 'ct-escala-texto')
        .attr('x', anchoBarra / 2)
        .attr('y', -10)
        .attr('text-anchor', 'middle')
        .text(elegida < 1 ? elegida * 1000 + ' m' : elegida + ' km');
    }

    /* ------------------------------------------------------------------
       Marcadores
       ------------------------------------------------------------------ */
    function escalaRadio() {
      return d3
        .scaleSqrt()
        .domain([0, d3.max(datos, function (d) { return d.Peso_Quintales; }) || 1])
        .range([5, 20]);
    }

    /**
     * Contra-escala todo lo rotulado para que conserve su tamano en pantalla.
     * Recorre gZoom entero (no solo gPuntos) porque los rotulos de distancia
     * cuelgan de la capa de vectores.
     */
    function contraEscalar() {
      gZoom.selectAll('g.ct-marcador > g').attr('transform', 'scale(' + 1 / kActual + ')');
    }

    function pintarMarcadores() {
      gPuntos.selectAll('*').remove();
      gDeriva.selectAll('*').remove();
      if (!datos.length) return;

      if (kActual < UMBRAL_CLUSTER) pintarCluster();
      else pintarFincas();

      contraEscalar();
    }

    /** Vista alejada: un marcador agregado por zona de acopio. */
    function pintarCluster() {
      var quintales = d3.sum(datos, function (d) { return d.Peso_Quintales; });
      var cluster = {
        lon: d3.mean(datos, function (d) { return d.lon; }),
        lat: d3.mean(datos, function (d) { return d.lat; }),
        quintales: quintales,
        riesgo: peorRiesgo(datos),
        dep: depAcopio ? depAcopio.properties.dep : 'Zona de acopio',
        registros: datos
      };

      var p = proyeccion([cluster.lon, cluster.lat]);
      if (!p) return;

      var g = gPuntos
        .append('g')
        .attr('class', 'ct-marcador ct-marcador--cluster')
        .attr('transform', 'translate(' + p[0] + ',' + p[1] + ')')
        .on('mouseenter', function (evento) {
          mostrarTooltip(contenidoCluster(cluster), evento);
        })
        .on('mousemove', moverTooltip)
        .on('mouseleave', ocultarTooltip)
        .on('click', function () {
          ocultarTooltip();
          barra.selectAll('button').classed('is-active', function () {
            return this.getAttribute('data-vista') === 'acopio';
          });
          irA(bboxFincas());
        });

      var inner = g.append('g');

      if (cluster.riesgo === 'Critico' || cluster.riesgo === 'Alto') {
        inner
          .append('circle')
          .attr('class', 'ct-pulso')
          .attr('r', 24)
          .attr('fill', 'none')
          .attr('stroke', colorDe(cluster.riesgo));
      }

      inner
        .append('circle')
        .attr('class', 'ct-marca')
        .attr('r', 17)
        .attr('fill', colorDe(cluster.riesgo))
        .attr('stroke', '#fff');

      inner
        .append('text')
        .attr('class', 'ct-cluster-num')
        .attr('text-anchor', 'middle')
        .attr('dy', 5)
        .text(datos.length);

      inner
        .append('text')
        .attr('class', 'ct-etiqueta')
        .attr('text-anchor', 'middle')
        .attr('y', -25)
        .text(cluster.dep + ' · ' + d3.format(',')(quintales) + ' qq');
    }

    /** Vista acercada: cada finca por separado. */
    function pintarFincas() {
      var r = escalaRadio();

      // --- Vectores de deriva, rotulados con la distancia real
      calcularVectoresDeriva(datos).forEach(function (d) {
        var a = proyeccion([d.origen.lon, d.origen.lat]);
        var b = proyeccion([d.destino.lon, d.destino.lat]);
        if (!a || !b) return;

        gDeriva
          .append('line')
          .attr('class', 'ct-vector')
          .attr('x1', a[0]).attr('y1', a[1])
          .attr('x2', b[0]).attr('y2', b[1]);

        // La distancia es el dato que sostiene el argumento de deriva:
        // se calcula sobre la esfera, no sobre los pixeles del mapa.
        var d_km = km([d.origen.lon, d.origen.lat], [d.destino.lon, d.destino.lat]);
        var etiqueta = d_km < 1
          ? Math.round(d_km * 1000) + ' m'
          : d_km.toFixed(1) + ' km';

        gDeriva
          .append('g')
          .attr('class', 'ct-marcador ct-vector-rotulo')
          .attr('transform', 'translate(' + (a[0] + b[0]) / 2 + ',' + (a[1] + b[1]) / 2 + ')')
          .append('g')
          .append('text')
          .attr('class', 'ct-etiqueta ct-etiqueta--dist')
          .attr('text-anchor', 'middle')
          .attr('dy', -4)
          .text(etiqueta);
      });

      // --- Fincas
      var grupos = gPuntos
        .selectAll('g.ct-marcador')
        .data(datos, function (d) { return d.ID_Lote; })
        .enter()
        .append('g')
        .attr('class', 'ct-marcador ct-finca')
        .attr('transform', function (d) {
          var p = proyeccion([d.lon, d.lat]);
          return p ? 'translate(' + p[0] + ',' + p[1] + ')' : null;
        })
        .classed('is-selected', function (d) { return d.ID_Lote === seleccionado; })
        .on('mouseenter', function (evento, d) { mostrarTooltip(contenidoFinca(d), evento); })
        .on('mousemove', moverTooltip)
        .on('mouseleave', ocultarTooltip)
        .on('click', function (evento, d) {
          seleccionar(d.ID_Lote);
          if (opciones.onSelect) opciones.onSelect(d);
        });

      var inner = grupos.append('g');

      // Anillo pulsante solo en criticos: dirige la mirada del supervisor.
      inner
        .filter(function (d) { return d.Riesgo === 'Critico'; })
        .append('circle')
        .attr('class', 'ct-pulso')
        .attr('r', function (d) { return r(d.Peso_Quintales) + 7; })
        .attr('fill', 'none')
        .attr('stroke', colorDe('Critico'));

      // Marca: circulo (organico) o rombo (convencional).
      inner.each(function (d) {
        var g = d3.select(this);
        var radio = r(d.Peso_Quintales);
        if (d.Certificacion_Declarada === 'Convencional') {
          g.append('path')
            .attr('class', 'ct-marca')
            // Misma AREA que el circulo del mismo radio: el rombo solo
            // cambia la forma (convencional), no el peso que codifica.
            .attr('d', d3.symbol().type(d3.symbolDiamond).size(Math.PI * radio * radio)())
            .attr('fill', colorDe(d.Riesgo))
            .attr('stroke', '#fff');
        } else {
          g.append('circle')
            .attr('class', 'ct-marca')
            .attr('r', radio)
            .attr('fill', colorDe(d.Riesgo))
            .attr('stroke', '#fff');
        }
      });

      inner
        .append('text')
        .attr('class', 'ct-etiqueta')
        .attr('text-anchor', 'middle')
        .attr('y', function (d) {
          var offset = r(d.Peso_Quintales) *
            (d.Certificacion_Declarada === 'Convencional' ? ALTO_ROMBO : 1);
          return -offset - 8;
        })
        .text(function (d) { return d.ID_Lote; });
    }

    /* ------------------------------------------------------------------
       Render completo (idempotente: se rellama en cada resize)
       ------------------------------------------------------------------ */
    function render() {
      var nodo = contenedor.node();
      var w = anchoUtil(nodo);
      var h = altoUtil();

      svg
        .attr('viewBox', '0 0 ' + (w + MARGEN * 2) + ' ' + (h + MARGEN * 2))
        .attr('width', '100%')
        .attr('height', h + MARGEN * 2);

      // fitExtent al bbox de los departamentos: el encuadre es el Peru y
      // solo el Peru, sin el resto del continente alrededor.
      proyeccion.fitExtent([[MARGEN, MARGEN], [w, h]], geo);

      gDeps
        .selectAll('path')
        .data(geo.features)
        .join('path')
        .attr('class', function (f) {
          return 'ct-dep' + (depAcopio && f === depAcopio ? ' is-acopio' : '');
        })
        .attr('d', camino)
        .append('title')
        .text(function (f) { return f.properties.dep; });

      pintarReticula();
      pintarMarcadores();
      pintarEscala();
    }

    /* ------------------------------------------------------------------
       API del modulo
       ------------------------------------------------------------------ */
    function actualizar(registros) {
      datos = registros;

      // Departamento que concentra el acopio: el que contiene mas fincas.
      var conteo = new Map();
      datos.forEach(function (d) {
        geo.features.forEach(function (f) {
          if (d3.geoContains(f, [d.lon, d.lat])) {
            conteo.set(f, (conteo.get(f) || 0) + 1);
          }
        });
      });
      depAcopio = null;
      conteo.forEach(function (n, f) {
        if (!depAcopio || n > conteo.get(depAcopio)) depAcopio = f;
      });

      render();
    }

    function seleccionar(idLote) {
      seleccionado = idLote;
      gPuntos.selectAll('g.ct-finca').classed('is-selected', function (d) {
        return d.ID_Lote === idLote;
      });

      // Si el lote seleccionado no es visible por estar agrupado, acercamos.
      if (kActual < UMBRAL_CLUSTER && datos.length) {
        barra.selectAll('button').classed('is-active', function () {
          return this.getAttribute('data-vista') === 'acopio';
        });
        irA(bboxFincas());
      }
    }

    // Re-render responsivo (debounce para no repintar en cada pixel).
    var timer = null;
    global.addEventListener('resize', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        // El resize invalida la proyeccion; volvemos a la vista completa.
        svg.call(zoom.transform, d3.zoomIdentity);
        kActual = 1;
        barra.selectAll('button').classed('is-active', function () {
          return this.getAttribute('data-vista') === 'peru';
        });
        render();
      }, 160);
    });

    return { actualizar: actualizar, seleccionar: seleccionar, colorDe: colorDe };
  }

  CT.MapRisk = { crear: crear, COLORES: COLORES, colorDe: colorDe };
})(window);
