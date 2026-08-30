/* ==========================================================================
   CafeTrace · modules/map-filters.js
   --------------------------------------------------------------------------
   Barra de filtros del mapa de riesgo.

   Cuatro dimensiones, las mismas que usa el supervisor cuando arma un
   embarque:
     EMPRESA / EXPORTADORA  quien comercializa el lote
     TAMANO DE LOTE         Pequeno / Mediano / Grande (cortes en CONFIG)
     TIPO DE AGROQUIMICO    residuo detectado por el panel ELISA
     DESTINO                mercado de exportacion

   El filtro es transversal: el mismo subconjunto alimenta el mapa, el feed
   de alertas y los KPIs. Si el usuario filtra "Perhusa + Alemania", los
   indicadores de arriba responden a esa cartera, no al total. Filtrar y
   que los numeros no acompanen seria enganoso.

   Las opciones se derivan del dataset en cada recarga (no hay listas
   hardcodeadas): un alta desde el formulario aparece sola en los combos.
   ========================================================================== */
(function (global) {
  'use strict';

  var CT = (global.CT = global.CT || {});

  var TODOS = '__TODOS__';

  // Valores especiales del combo de agroquimico, mas alla de los 4 kits.
  var CUALQUIER_RESIDUO = '__CUALQUIERA__';
  var SIN_RESIDUO = '__NINGUNO__';

  var ETIQUETAS_TAMANO = {
    Pequeno: 'Pequeno (< 100 qq)',
    Mediano: 'Mediano (100 – 199 qq)',
    Grande: 'Grande (≥ 200 qq)'
  };

  var ORDEN_TAMANO = ['Pequeno', 'Mediano', 'Grande'];

  /* ---------------------------------------------------------------------
     Predicados: uno por dimension.
     --------------------------------------------------------------------- */
  var DIMENSIONES = [
    {
      id: 'empresa',
      etiqueta: 'Empresa / exportadora',
      opciones: function (registros) {
        return unicos(registros, function (r) { return r.Empresa_Exportadora; });
      },
      coincide: function (r, valor) {
        return r.Empresa_Exportadora === valor;
      }
    },
    {
      id: 'tamano',
      etiqueta: 'Lote / tamano',
      opciones: function (registros) {
        return unicos(registros, function (r) { return r.Tamano_Lote; })
          .sort(function (a, b) {
            return ORDEN_TAMANO.indexOf(a) - ORDEN_TAMANO.indexOf(b);
          })
          .map(function (t) { return { valor: t, texto: ETIQUETAS_TAMANO[t] || t }; });
      },
      coincide: function (r, valor) {
        return r.Tamano_Lote === valor;
      }
    },
    {
      id: 'agroquimico',
      etiqueta: 'Tipo de agroquimico',
      opciones: function () {
        return [{ valor: CUALQUIER_RESIDUO, texto: 'Con residuo detectado (cualquiera)' }]
          .concat(
            CT.DataLoader.PANEL.map(function (a) {
              return { valor: a.nombre, texto: a.nombre + ' · ' + a.clase };
            })
          )
          .concat([{ valor: SIN_RESIDUO, texto: 'Sin residuo detectado' }]);
      },
      coincide: function (r, valor) {
        if (valor === CUALQUIER_RESIDUO) return r.Agroquimicos_Detectados.length > 0;
        if (valor === SIN_RESIDUO) return r.Agroquimicos_Detectados.length === 0;
        return r.Agroquimicos_Detectados.indexOf(valor) >= 0;
      }
    },
    {
      id: 'destino',
      etiqueta: 'Destino',
      opciones: function (registros) {
        return unicos(registros, function (r) { return r.Destino; }).map(function (d) {
          return { valor: d, texto: d.replace(/_/g, ' ') };
        });
      },
      coincide: function (r, valor) {
        return r.Destino === valor;
      }
    }
  ];

  function unicos(registros, fn) {
    var set = new Set();
    registros.forEach(function (r) {
      var v = fn(r);
      if (v) set.add(v);
    });
    return Array.from(set).sort();
  }

  /** Homogeneiza `opciones()`: acepta strings sueltos o {valor, texto}. */
  function normalizarOpciones(lista) {
    return lista.map(function (o) {
      return typeof o === 'string' ? { valor: o, texto: o } : o;
    });
  }

  /* ---------------------------------------------------------------------
     Modulo
     --------------------------------------------------------------------- */
  /**
   * @param {string} selector Contenedor donde montar la barra.
   * @param {Object} opciones { onChange: fn(seleccion) }
   */
  function crear(selector, opciones) {
    opciones = opciones || {};

    var contenedor = d3.select(selector);
    var registros = [];
    var seleccion = {};

    DIMENSIONES.forEach(function (d) { seleccion[d.id] = TODOS; });

    var fila = contenedor.append('div').attr('class', 'ct-filtros-mapa');
    var controles = {};

    DIMENSIONES.forEach(function (dim) {
      var campo = fila.append('label').attr('class', 'ct-filtro');
      campo.append('span').attr('class', 'ct-filtro-label').text(dim.etiqueta);

      var select = campo
        .append('select')
        .attr('class', 'ct-filtro-select')
        .attr('data-dim', dim.id)
        .on('change', function () {
          seleccion[dim.id] = this.value;
          emitir();
        });

      controles[dim.id] = select;
    });

    var pie = fila.append('div').attr('class', 'ct-filtros-pie');

    var resumen = pie.append('span').attr('class', 'ct-filtros-resumen');

    var btnLimpiar = pie
      .append('button')
      .attr('type', 'button')
      .attr('class', 'ct-btn ct-btn--ghost ct-filtros-reset')
      .attr('hidden', true)
      .text('Limpiar filtros')
      .on('click', function () {
        DIMENSIONES.forEach(function (d) {
          seleccion[d.id] = TODOS;
          controles[d.id].property('value', TODOS);
        });
        emitir();
      });

    /** Repuebla los combos conservando la seleccion vigente si sigue siendo valida. */
    function poblar() {
      DIMENSIONES.forEach(function (dim) {
        var lista = normalizarOpciones(dim.opciones(registros));
        var select = controles[dim.id];
        var actual = seleccion[dim.id];

        var datos = [{ valor: TODOS, texto: 'Todas' }].concat(lista);
        if (dim.id !== 'empresa') datos[0].texto = 'Todos';

        select
          .selectAll('option')
          .data(datos, function (o) { return o.valor; })
          .join('option')
          .attr('value', function (o) { return o.valor; })
          .text(function (o) { return o.texto; });

        // Si el dataset dejo de contener el valor filtrado (p.ej. se borraron
        // las altas locales), volvemos a "Todos" en vez de mostrar 0 lotes.
        var vigente = datos.some(function (o) { return o.valor === actual; });
        if (!vigente) seleccion[dim.id] = TODOS;
        select.property('value', seleccion[dim.id]);
      });
    }

    /** Aplica la seleccion actual sobre una lista de registros. */
    function aplicar(lista) {
      return lista.filter(function (r) {
        return DIMENSIONES.every(function (dim) {
          var valor = seleccion[dim.id];
          return valor === TODOS || dim.coincide(r, valor);
        });
      });
    }

    function activos() {
      return DIMENSIONES.filter(function (d) {
        return seleccion[d.id] !== TODOS;
      }).length;
    }

    function emitir() {
      var visibles = aplicar(registros);
      pintarResumen(visibles.length);
      if (opciones.onChange) opciones.onChange(visibles, activos());
    }

    function pintarResumen(n) {
      var total = registros.length;
      var nActivos = activos();

      btnLimpiar.attr('hidden', nActivos ? null : true);

      if (!nActivos) {
        resumen.attr('class', 'ct-filtros-resumen').text(
          total + ' lote(s) · sin filtros'
        );
        return;
      }

      resumen
        .attr('class', 'ct-filtros-resumen is-activo')
        .text(
          n + ' de ' + total + ' lote(s) · ' + nActivos + ' filtro(s) activo(s)' +
          (n === 0 ? ' · ningun lote coincide' : '')
        );
    }

    /** Recibe el dataset completo; devuelve el subconjunto ya filtrado. */
    function actualizar(nuevos) {
      registros = nuevos;
      poblar();
      var visibles = aplicar(registros);
      pintarResumen(visibles.length);
      return visibles;
    }

    return {
      actualizar: actualizar,
      aplicar: aplicar,
      seleccion: function () {
        return Object.assign({}, seleccion);
      },
      activos: activos
    };
  }

  CT.MapFilters = { crear: crear, DIMENSIONES: DIMENSIONES, TODOS: TODOS };
})(window);
