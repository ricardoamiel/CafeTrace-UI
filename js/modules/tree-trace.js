/* ==========================================================================
   CafeTrace · modules/tree-trace.js
   --------------------------------------------------------------------------
   Arbol de Trazabilidad del Lote (Pasaporte Digital).

   Despliega la cadena de custodia como jerarquia D3 horizontal:

     [Finca / Productor]  ->  [Test ELISA]  ->  [Lote consolidado]  ->  [Destino]

   Cuando el motor de reglas marca el lote como Critico, el nodo de destino
   se bifurca en dos ramas para hacer visible la decision comercial:

        [Lote] -- x --> [Exportacion UE]          (rama bloqueada)
               \-----> [Venta convencional local] (rama que salva el valor)

   Esa bifurcacion es el argumento central del proyecto: la segregacion
   temprana convierte una perdida total del contenedor en una venta a menor
   precio pero sin penalizacion ni riesgo de descertificacion.
   ========================================================================== */
(function (global) {
  'use strict';

  var CT = (global.CT = global.CT || {});

  var MARGEN = { top: 28, right: 190, bottom: 28, left: 130 };
  var NODO = { w: 168, h: 52 };

  /** Nodo de la etapa 2: resumen del panel ELISA del lote. */
  function construirNodoPanel(r) {
    if (!r.Kits_Ejecutados) {
      return {
        etapa: '2 · Panel ELISA',
        titulo: 'SIN PANEL',
        detalle: '0/' + r.Kits_Totales + ' kits · eslabon faltante',
        tipo: 'faltante'
      };
    }

    var cobertura = r.Kits_Ejecutados + '/' + r.Kits_Totales + ' kits';

    if (r.Hallazgos.length) {
      var h = r.Hallazgo_Principal;
      return {
        etapa: '2 · Panel ELISA',
        titulo: h.Agroquimico.toUpperCase(),
        detalle:
          (h.Tipo_Lectura === 'Cualitativo'
            ? 'detectado (cualitativo)'
            : h.Valor_ppm.toFixed(2) + ' ppm > ' + h.Umbral_ppm) +
          ' · ' + cobertura,
        tipo: 'critico'
      };
    }

    if (r.Kits_Faltantes.length) {
      return {
        etapa: '2 · Panel ELISA',
        titulo: 'PANEL ABIERTO',
        detalle: 'faltan ' + r.Kits_Faltantes.join(', '),
        tipo: 'pendiente'
      };
    }

    return {
      etapa: '2 · Panel ELISA',
      titulo: 'PANEL CERRADO',
      detalle: cobertura + ' conformes · ' + (r.Operador || 'acopio'),
      tipo: 'ok'
    };
  }

  /* ---------------------------------------------------------------------
     Construccion de la jerarquia a partir de un registro unido.
     --------------------------------------------------------------------- */
  function construirJerarquia(r) {
    var penalizacion = CT.DataLoader.CONFIG.PENALIZACION_USD_POR_QUINTAL;

    // --- Etapa 3/4: destino(s)
    var hojas;
    if (r.Segregado) {
      hojas = [
        {
          etapa: 'Rama bloqueada',
          titulo: 'Exportacion ' + (r.Destino === 'Pendiente' ? 'UE' : r.Destino),
          detalle: 'Penalizacion evitada: US$ ' +
            d3.format(',')(r.Peso_Quintales * penalizacion),
          tipo: 'bloqueado',
          bloqueado: true
        },
        {
          etapa: 'Rama de rescate',
          titulo: 'Venta convencional local',
          detalle: r.Peso_Quintales + ' qq redirigidos · valor comercial salvado',
          tipo: 'rescate'
        }
      ];
    } else if (r.Certificacion_Declarada !== 'Organico') {
      hojas = [
        {
          etapa: 'Destino',
          titulo: r.Destino,
          detalle: 'Canal convencional · ' + r.Estado_Transito.replace(/_/g, ' '),
          tipo: 'neutro'
        }
      ];
    } else if (r.Kits_Faltantes.length) {
      hojas = [
        {
          etapa: 'Destino',
          titulo: r.Destino,
          detalle: 'BLOQUEADO hasta cerrar el panel ELISA',
          tipo: 'pendiente'
        }
      ];
    } else {
      hojas = [
        {
          etapa: 'Destino',
          titulo: r.Destino,
          detalle: 'Pasaporte completo · ' + r.Estado_Transito.replace(/_/g, ' '),
          tipo: 'ok'
        }
      ];
    }

    // --- Etapa 2: verificacion contra el panel de kits.
    // El nodo resume el panel y cuelga un nodo hijo por kit corrido: la
    // cadena de custodia ya no es "hay test o no hay", es cuantos de los
    // agroquimicos del protocolo quedaron efectivamente cubiertos.
    var nodoTest = construirNodoPanel(r);

    nodoTest.children = [
      {
        etapa: '3 · Lote consolidado',
        titulo: r.ID_Lote,
        detalle: r.Peso_Quintales + ' qq · ' + r.Estado_Seguridad.replace(/_/g, ' '),
        tipo: r.Segregado ? 'critico' : 'neutro',
        children: hojas
      }
    ];

    // --- Etapa 1: origen
    return {
      etapa: '1 · Origen',
      titulo: r.Finca,
      detalle: r.Nombre + ' · ' + r.Certificacion_Declarada +
        ' · prox. ' + r.Proximidad_Finca_Convencional,
      tipo: r.Certificacion_Declarada === 'Organico' ? 'origen' : 'neutro',
      children: [nodoTest]
    };
  }

  /* ---------------------------------------------------------------------
     Modulo
     --------------------------------------------------------------------- */
  function crear(selector) {
    var contenedor = d3.select(selector);
    var registroActual = null;

    var svg = contenedor.append('svg').attr('class', 'ct-svg ct-tree');
    var g = svg.append('g');
    var vacio = contenedor
      .append('div')
      .attr('class', 'ct-empty')
      .html(
        '<span class="ct-empty-ico">&#9758;</span>' +
          'Selecciona una finca en el mapa o una alerta del panel derecho ' +
          'para desplegar su pasaporte digital de trazabilidad.'
      );

    function render() {
      if (!registroActual) return;

      var nodo = contenedor.node();
      var ancho = Math.max(nodo.clientWidth, 320);

      var raiz = d3.hierarchy(construirJerarquia(registroActual));
      var nHojas = raiz.leaves().length;
      var alto = Math.max(260, nHojas * 108 + MARGEN.top + MARGEN.bottom);

      var w = ancho - MARGEN.left - MARGEN.right;
      var h = alto - MARGEN.top - MARGEN.bottom;

      svg.attr('viewBox', '0 0 ' + ancho + ' ' + alto).attr('width', '100%').attr('height', alto);
      g.attr('transform', 'translate(' + MARGEN.left + ',' + MARGEN.top + ')');

      // Layout horizontal: d3.tree trabaja en (x = vertical, y = horizontal).
      d3.tree().size([h, w])(raiz);

      g.selectAll('*').remove();

      // --- Enlaces
      g.selectAll('path.ct-link')
        .data(raiz.links())
        .enter()
        .append('path')
        .attr('class', function (d) {
          return 'ct-link ct-link--' + (d.target.data.tipo || 'neutro');
        })
        .attr(
          'd',
          d3
            .linkHorizontal()
            .x(function (d) { return d.y; })
            .y(function (d) { return d.x; })
        );

      // Cruz sobre la rama bloqueada: la exportacion que NO ocurre.
      raiz.links().forEach(function (d) {
        if (!d.target.data.bloqueado) return;
        var mx = (d.source.y + d.target.y) / 2;
        var my = (d.source.x + d.target.x) / 2;
        g.append('text')
          .attr('class', 'ct-corte')
          .attr('x', mx)
          .attr('y', my + 6)
          .attr('text-anchor', 'middle')
          .text('✕');
      });

      // --- Nodos
      var nodos = g
        .selectAll('g.ct-node')
        .data(raiz.descendants())
        .enter()
        .append('g')
        .attr('class', function (d) { return 'ct-node ct-node--' + (d.data.tipo || 'neutro'); })
        .attr('transform', function (d) {
          return 'translate(' + (d.y - NODO.w / 2) + ',' + (d.x - NODO.h / 2) + ')';
        });

      nodos
        .append('rect')
        .attr('width', NODO.w)
        .attr('height', NODO.h)
        .attr('rx', 8);

      nodos
        .append('text')
        .attr('class', 'ct-node-etapa')
        .attr('x', 12)
        .attr('y', 16)
        .text(function (d) { return d.data.etapa; });

      nodos
        .append('text')
        .attr('class', 'ct-node-titulo')
        .attr('x', 12)
        .attr('y', 33)
        .text(function (d) { return truncar(d.data.titulo, 22); });

      nodos
        .append('text')
        .attr('class', 'ct-node-detalle')
        .attr('x', 12)
        .attr('y', 46)
        .text(function (d) { return truncar(d.data.detalle, 30); });

      // Titulos nativos: en tablet el hover no existe, pero el detalle
      // completo queda accesible para lectores de pantalla y en desktop.
      nodos.append('title').text(function (d) {
        return d.data.etapa + ' — ' + d.data.titulo + '\n' + d.data.detalle;
      });
    }

    function truncar(texto, max) {
      texto = String(texto || '');
      return texto.length > max ? texto.slice(0, max - 1) + '…' : texto;
    }

    function mostrar(registro) {
      registroActual = registro;
      vacio.style('display', 'none');
      svg.style('display', 'block');
      render();
    }

    function limpiar() {
      registroActual = null;
      g.selectAll('*').remove();
      svg.style('display', 'none');
      vacio.style('display', '');
    }

    limpiar();

    var timer = null;
    global.addEventListener('resize', function () {
      clearTimeout(timer);
      timer = setTimeout(render, 140);
    });

    return { mostrar: mostrar, limpiar: limpiar };
  }

  CT.TreeTrace = { crear: crear, construirJerarquia: construirJerarquia };
})(window);
