/* ==========================================================================
   CafeTrace · modules/alerts-feed.js
   --------------------------------------------------------------------------
   Panel de Alertas.

   Traduce la salida del motor de reglas a tarjetas accionables. La tarjeta
   es deliberadamente CORTA: cuatro bullets y nada mas.

       · Ubicacion            donde esta el lote
       · Tipo de agroquimico  que encontro (o que falta por medir) el panel
       · Empresa/exportadora  quien responde comercialmente
       · Resultado del test   contaminado / conforme / sin verificar

   El supervisor triangula con esos cuatro datos en el acopio, con una
   tablet y sin tiempo. El parrafo de contexto, la exposicion economica y
   el plan de accion se despliegan bajo demanda con "Ver mas detalles", y
   los genera CT.Advisor (scorecard parametrizado; ver advisor.js).

   Tipos de alerta emitidos:
     CRITICA        Residuo sobre criterio en lote declarado organico.
     INCONSISTENCIA Panel sin ejecutar o incompleto (cadena rota).
     MONITOREO      Lote conforme pero con deriva potencial por proximidad.
     AUDITORIA      El riesgo declarado en el CSV no coincide con el calculado.
   ========================================================================== */
(function (global) {
  'use strict';

  var CT = (global.CT = global.CT || {});

  // Orden de severidad para el feed (mayor primero).
  var PESO = { CRITICA: 4, INCONSISTENCIA: 3, AUDITORIA: 2, MONITOREO: 1 };

  var fmtUSD = d3.format(',.0f');

  /* ---------------------------------------------------------------------
     Bullets: los cuatro datos que se ven sin desplegar nada.
     --------------------------------------------------------------------- */
  function ubicacionDe(r) {
    var partes = [r.Finca];
    if (r.Departamento) partes.push(r.Departamento);
    else partes.push(r.lat.toFixed(3) + ', ' + r.lon.toFixed(3));
    return partes.join(' · ');
  }

  /** Frase corta del kit: que se detecto, o que falta por medir. */
  function agroquimicoDe(r) {
    if (r.Hallazgos.length) {
      var h = r.Hallazgo_Principal;
      var texto = h.Tipo_Lectura === 'Cualitativo'
        ? h.Agroquimico + ' · deteccion cualitativa'
        : h.Agroquimico + ' ' + h.Valor_ppm.toFixed(2) + ' ppm (umbral ' +
          h.Umbral_ppm.toFixed(2) + ')';
      if (r.Hallazgos.length > 1) texto += ' +' + (r.Hallazgos.length - 1) + ' mas';
      return texto;
    }
    if (r.Certificacion_Declarada !== 'Organico') {
      return 'Fuera del panel organico';
    }
    if (!r.Kits_Ejecutados) {
      return 'Panel sin ejecutar (0/' + r.Kits_Totales + ' kits)';
    }
    if (r.Kits_Faltantes.length) {
      return 'Faltan ' + r.Kits_Faltantes.join(', ') +
        ' (' + r.Kits_Ejecutados + '/' + r.Kits_Totales + ' kits)';
    }
    return 'Panel completo sin residuos (' + r.Kits_Totales + '/' + r.Kits_Totales + ' kits)';
  }

  /** Pastilla de resultado: la respuesta binaria que el comprador pide. */
  function resultadoDe(r) {
    switch (r.Resultado_ELISA) {
      case 'Contaminado':
        return { texto: 'CONTAMINADO', clase: 'malo' };
      case 'Panel_Incompleto':
        return { texto: 'VERIFICACION PARCIAL', clase: 'parcial' };
      case 'Sin_Test':
        return { texto: 'SIN VERIFICAR', clase: 'sin' };
      case 'No_Aplica':
        return { texto: 'FUERA DE ALCANCE', clase: 'sin' };
      default:
        return { texto: 'NO CONTAMINADO', clase: 'bueno' };
    }
  }

  function bulletsDe(r) {
    return [
      { k: 'Ubicacion', v: ubicacionDe(r) },
      { k: 'Agroquimico', v: agroquimicoDe(r) },
      { k: 'Exportadora', v: r.Empresa_Exportadora },
      { k: 'Resultado test', v: resultadoDe(r), pastilla: true }
    ];
  }

  /* ---------------------------------------------------------------------
     Generacion de alertas
     --------------------------------------------------------------------- */
  function generar(registros) {
    var alertas = [];

    registros.forEach(function (r) {
      if (r.Riesgo === 'Critico') {
        alertas.push(construir('CRITICA', 'Contaminacion detectada', r));
      }

      if (r.Riesgo === 'Alto') {
        alertas.push(
          construir(
            'INCONSISTENCIA',
            r.Kits_Ejecutados ? 'Panel de verificacion incompleto' : 'Organico sin verificar',
            r
          )
        );
      }

      if (r.Riesgo === 'Medio') {
        alertas.push(construir('MONITOREO', 'Deriva potencial', r));
      }

      if (r.Divergencia_Riesgo) {
        alertas.push(construir('AUDITORIA', 'Riesgo mal declarado', r));
      }
    });

    return alertas.sort(function (a, b) {
      return PESO[b.tipo] - PESO[a.tipo] || String(a.idLote).localeCompare(String(b.idLote));
    });
  }

  function construir(tipo, titulo, r) {
    return {
      tipo: tipo,
      idLote: r.ID_Lote,
      titulo: titulo,
      bullets: bulletsDe(r),
      meta: r.Timestamp,
      registro: r
    };
  }

  /* ---------------------------------------------------------------------
     Detalle bajo demanda (analisis parametrizado)
     --------------------------------------------------------------------- */
  function pintarDetalle(sel, alerta) {
    var r = alerta.registro;
    var a = CT.Advisor.analizar(r);

    sel.selectAll('*').remove();

    var cab = sel.append('div').attr('class', 'ct-detalle-head');
    cab
      .append('span')
      .attr('class', 'ct-detalle-prioridad is-' + a.clase)
      .text('Prioridad ' + a.prioridad);
    cab
      .append('span')
      .attr('class', 'ct-detalle-score')
      .text('score ' + a.score + '/100');

    var barra = sel.append('div').attr('class', 'ct-detalle-barra');
    barra
      .append('span')
      .attr('class', 'is-' + a.clase)
      .style('width', a.score + '%');

    // --- Motivo del motor de reglas (la regla que disparo la alerta)
    sel
      .append('p')
      .attr('class', 'ct-detalle-motivo')
      .text(r.Motivo);

    // --- Factores ponderados
    sel.append('h5').attr('class', 'ct-detalle-titulo').text('Factores evaluados');
    var factores = sel.append('ul').attr('class', 'ct-detalle-factores');
    factores
      .selectAll('li')
      .data(a.factores)
      .enter()
      .append('li')
      .html(function (f) {
        return '<strong>' + escapar(f.etiqueta) + '</strong> ' +
          '<span class="ct-detalle-puntos">+' + Math.round(f.puntos) + '</span><br>' +
          escapar(f.detalle);
      });

    // --- Impacto economico
    var eco = sel.append('p').attr('class', 'ct-detalle-eco');
    if (r.Ahorro_USD > 0) {
      eco.html(
        'Ahorro al segregar a tiempo: <strong>US$ ' + fmtUSD(a.ahorro) + '</strong> ' +
        '(' + r.Peso_Quintales + ' qq × US$' +
        CT.DataLoader.CONFIG.PENALIZACION_USD_POR_QUINTAL + '/qq).'
      );
    } else {
      eco.html(
        'Exposicion si embarca sin corregir: <strong>US$ ' + fmtUSD(a.exposicion) +
        '</strong> (' + r.Peso_Quintales + ' qq × US$' +
        CT.DataLoader.CONFIG.PENALIZACION_USD_POR_QUINTAL + '/qq).'
      );
    }

    // --- Plan de accion
    sel.append('h5').attr('class', 'ct-detalle-titulo').text('Acciones recomendadas');
    var acciones = sel.append('ol').attr('class', 'ct-detalle-acciones');
    acciones
      .selectAll('li')
      .data(a.acciones)
      .enter()
      .append('li')
      .text(function (t) { return t; });

    // --- Panel completo (todas las lecturas del lote)
    if (r.Tests.length) {
      sel.append('h5').attr('class', 'ct-detalle-titulo').text('Panel ELISA del lote');
      var tabla = sel.append('table').attr('class', 'ct-detalle-panel');
      var filas = tabla
        .append('tbody')
        .selectAll('tr')
        .data(r.Tests)
        .enter()
        .append('tr')
        .attr('class', function (t) { return t.Excede ? 'is-hallazgo' : null; });

      filas.append('th').attr('scope', 'row').text(function (t) { return t.Agroquimico; });
      filas.append('td').text(function (t) {
        return t.Tipo_Lectura === 'Cualitativo'
          ? (t.Detectado ? 'Detectado' : 'No detectado')
          : t.Valor_ppm.toFixed(2) + ' ppm';
      });
      filas.append('td').attr('class', 'ct-detalle-umbral').text(function (t) {
        return t.Tipo_Lectura === 'Cualitativo'
          ? 'cualitativo'
          : 'umbral ' + t.Umbral_ppm.toFixed(2);
      });
    }

    sel.append('p').attr('class', 'ct-detalle-nota').text(a.notas);
  }

  function escapar(texto) {
    return String(texto)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /* ---------------------------------------------------------------------
     Render del feed
     --------------------------------------------------------------------- */
  function crear(selector, opciones) {
    opciones = opciones || {};
    var contenedor = d3.select(selector);
    var filtro = 'TODAS';
    var alertasActuales = [];
    var lotesVisibles = 0;   // para distinguir "sin alertas" de "sin lotes"


    // Lotes con el detalle desplegado: sobrevive al repintado del feed
    // (un alta desde el formulario no debe cerrar lo que estabas leyendo).
    var abiertos = new Set();

    var barra = contenedor.append('div').attr('class', 'ct-filtros');
    var lista = contenedor.append('div').attr('class', 'ct-feed');

    ['TODAS', 'CRITICA', 'INCONSISTENCIA', 'MONITOREO', 'AUDITORIA'].forEach(function (t) {
      barra
        .append('button')
        .attr('type', 'button')
        .attr('class', 'ct-chip' + (t === filtro ? ' is-active' : ''))
        .attr('data-tipo', t)
        .text(t === 'TODAS' ? 'Todas' : t.charAt(0) + t.slice(1).toLowerCase())
        .on('click', function () {
          filtro = t;
          barra.selectAll('button').classed('is-active', function () {
            return this.getAttribute('data-tipo') === filtro;
          });
          pintar();
        });
    });

    function claveDe(a) {
      return a.tipo + '::' + a.idLote;
    }

    function pintar() {
      var visibles = alertasActuales.filter(function (a) {
        return filtro === 'TODAS' || a.tipo === filtro;
      });

      lista.selectAll('*').remove();

      if (!visibles.length) {
        lista
          .append('p')
          .attr('class', 'ct-feed-vacio')
          .text(mensajeVacio());
        return;
      }

      var tarjetas = lista
        .selectAll('article')
        .data(visibles)
        .enter()
        .append('article')
        .attr('class', function (a) { return 'ct-alerta ct-alerta--' + a.tipo.toLowerCase(); });

      // --- Cabecera: tipo + lote + fecha del panel
      var cab = tarjetas.append('header').attr('class', 'ct-alerta-head');
      cab.append('span').attr('class', 'ct-alerta-tipo').text(function (a) { return a.tipo; });
      cab.append('span').attr('class', 'ct-alerta-meta').text(function (a) {
        return a.idLote + (a.meta ? ' · ' + formatearMeta(a.meta) : '');
      });

      // --- Titulo (clicable: abre el pasaporte de trazabilidad)
      tarjetas
        .append('button')
        .attr('type', 'button')
        .attr('class', 'ct-alerta-titulo')
        .text(function (a) { return a.titulo; })
        .on('click', function (evento, a) {
          if (opciones.onSelect) opciones.onSelect(a.registro);
        });

      // --- Los cuatro bullets
      var ul = tarjetas.append('ul').attr('class', 'ct-alerta-bullets');
      ul.selectAll('li')
        .data(function (a) { return a.bullets; })
        .enter()
        .append('li')
        .each(function (b) {
          var li = d3.select(this);
          li.append('span').attr('class', 'ct-bullet-k').text(b.k);
          if (b.pastilla) {
            li.append('span')
              .attr('class', 'ct-bullet-v ct-pastilla is-' + b.v.clase)
              .text(b.v.texto);
          } else {
            li.append('span').attr('class', 'ct-bullet-v').text(b.v);
          }
        });

      // --- Pie: desplegable del analisis parametrizado
      var pie = tarjetas.append('div').attr('class', 'ct-alerta-pie');

      pie
        .append('button')
        .attr('type', 'button')
        .attr('class', 'ct-vermas')
        .attr('aria-expanded', function (a) { return abiertos.has(claveDe(a)) ? 'true' : 'false'; })
        .text(function (a) {
          return abiertos.has(claveDe(a)) ? 'Ocultar detalles' : 'Ver mas detalles';
        })
        .on('click', function (evento, a) {
          var boton = d3.select(this);
          var detalle = d3.select(this.closest('.ct-alerta')).select('.ct-alerta-detalle');
          var abierto = abiertos.has(claveDe(a));

          if (abierto) {
            abiertos.delete(claveDe(a));
            detalle.attr('hidden', true);
            boton.attr('aria-expanded', 'false').text('Ver mas detalles');
          } else {
            abiertos.add(claveDe(a));
            pintarDetalle(detalle, a);
            detalle.attr('hidden', null);
            boton.attr('aria-expanded', 'true').text('Ocultar detalles');
          }
        });

      pie
        .append('button')
        .attr('type', 'button')
        .attr('class', 'ct-verpasaporte')
        .text('Pasaporte →')
        .on('click', function (evento, a) {
          if (opciones.onSelect) opciones.onSelect(a.registro);
        });

      // --- Contenedor del detalle (se rellena al abrir)
      tarjetas
        .append('div')
        .attr('class', 'ct-alerta-detalle')
        .attr('hidden', true)
        .each(function (a) {
          if (!abiertos.has(claveDe(a))) return;
          pintarDetalle(d3.select(this), a);
          d3.select(this).attr('hidden', null);
        });
    }

    /**
     * Tres situaciones distintas que un solo "no hay alertas" confundiria:
     * el filtro no devolvio lotes, el chip de tipo no tiene coincidencias, o
     * la cartera esta efectivamente limpia.
     */
    function mensajeVacio() {
      if (!lotesVisibles) {
        return 'Ningun lote coincide con los filtros del mapa.';
      }
      if (alertasActuales.length) {
        return 'Sin alertas de este tipo en la seleccion actual.';
      }
      return 'Sin alertas en esta seleccion. Cadena de custodia conforme.';
    }

    function formatearMeta(meta) {
      if (!meta) return '';
      var d = new Date(meta);
      if (isNaN(d.getTime())) return meta;
      return d.toLocaleString('es-PE', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      });
    }

    function actualizar(registros) {
      lotesVisibles = registros.length;
      alertasActuales = generar(registros);
      pintar();
      return alertasActuales;
    }

    return { actualizar: actualizar, generar: generar };
  }

  CT.AlertsFeed = { crear: crear, generar: generar, bulletsDe: bulletsDe };
})(window);
