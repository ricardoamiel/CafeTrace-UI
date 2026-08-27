/* ==========================================================================
   CafeTrace · modules/alerts-feed.js
   --------------------------------------------------------------------------
   Panel de Alertas.

   Traduce la salida del motor de reglas a mensajes accionables para el
   supervisor de la cooperativa. Cada alerta responde tres preguntas:
     QUE paso, CUANTO cuesta / ahorra, y QUE hacer ahora.

   Tipos de alerta emitidos:
     CRITICA       Glifosato sobre umbral en lote declarado organico.
     INCONSISTENCIA Lote organico sin test ELISA asociado (cadena rota).
     MONITOREO     Lote conforme pero con deriva potencial por proximidad.
     AUDITORIA     El riesgo declarado en el CSV no coincide con el calculado.
   ========================================================================== */
(function (global) {
  'use strict';

  var CT = (global.CT = global.CT || {});

  // Orden de severidad para el feed (mayor primero).
  var PESO = { CRITICA: 4, INCONSISTENCIA: 3, AUDITORIA: 2, MONITOREO: 1 };

  var fmtUSD = d3.format(',.0f');

  /* ---------------------------------------------------------------------
     Generacion de alertas
     --------------------------------------------------------------------- */
  function generar(registros) {
    var alertas = [];

    registros.forEach(function (r) {
      var penalizacion = CT.DataLoader.CONFIG.PENALIZACION_USD_POR_QUINTAL;

      if (r.Riesgo === 'Critico') {
        alertas.push({
          tipo: 'CRITICA',
          idLote: r.ID_Lote,
          titulo: 'Lote ' + r.ID_Lote + ' · contaminacion detectada',
          cuerpo:
            r.Finca + ' registra ' + r.Glifosato_ppm.toFixed(2) +
            ' ppm de glifosato (umbral ' + CT.DataLoader.CONFIG.UMBRAL_GLIFOSATO_PPM +
            ' ppm). Lote de ' + r.Peso_Quintales +
            ' qq segregado a mercado nacional antes del embarque.',
          impacto:
            'Ahorro estimado US$ ' + fmtUSD(r.Ahorro_USD) +
            ' al evitar la penalizacion de US$' + penalizacion + '/quintal en destino UE.',
          accion: r.Accion,
          meta: r.Timestamp,
          registro: r
        });
      }

      if (r.Riesgo === 'Alto') {
        alertas.push({
          tipo: 'INCONSISTENCIA',
          idLote: r.ID_Lote,
          titulo: 'Lote ' + r.ID_Lote + ' · organico sin verificar',
          cuerpo:
            r.Finca + ' declara certificacion organica, pero el lote de ' +
            r.Peso_Quintales + ' qq no tiene resultado ELISA asociado. ' +
            'El pasaporte digital esta incompleto.',
          impacto:
            'Exposicion maxima US$ ' + fmtUSD(r.Peso_Quintales * penalizacion) +
            ' si el lote embarca sin verificar y resulta contaminado en destino.',
          accion: r.Accion,
          meta: 'Sin timestamp de verificacion',
          registro: r
        });
      }

      if (r.Riesgo === 'Medio') {
        alertas.push({
          tipo: 'MONITOREO',
          idLote: r.ID_Lote,
          titulo: 'Lote ' + r.ID_Lote + ' · deriva potencial',
          cuerpo:
            r.Finca + ' esta conforme (' + r.Glifosato_ppm.toFixed(2) +
            ' ppm) pero colinda con parcelas convencionales (proximidad Alta).',
          impacto: 'Sin perdida actual. Probabilidad elevada de deriva en la proxima campana.',
          accion: r.Accion,
          meta: r.Timestamp,
          registro: r
        });
      }

      if (r.Divergencia_Riesgo) {
        alertas.push({
          tipo: 'AUDITORIA',
          idLote: r.ID_Lote,
          titulo: 'Lote ' + r.ID_Lote + ' · riesgo mal declarado',
          cuerpo:
            'El registro declara riesgo "' + (r.Riesgo_Declarado || 'vacio') +
            '" pero el motor de reglas calcula "' + r.Riesgo +
            '" a partir de la evidencia (' + r.Regla + ').',
          impacto: 'Riesgo de decision comercial tomada sobre un dato desactualizado.',
          accion: 'Revisar el registro del lote y sincronizar con el resultado ELISA vigente.',
          meta: 'Control de consistencia de datos',
          registro: r
        });
      }
    });

    return alertas.sort(function (a, b) {
      return PESO[b.tipo] - PESO[a.tipo] || String(a.idLote).localeCompare(String(b.idLote));
    });
  }

  /* ---------------------------------------------------------------------
     Render del feed
     --------------------------------------------------------------------- */
  function crear(selector, opciones) {
    opciones = opciones || {};
    var contenedor = d3.select(selector);
    var filtro = 'TODAS';
    var alertasActuales = [];

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

    function pintar() {
      var visibles = alertasActuales.filter(function (a) {
        return filtro === 'TODAS' || a.tipo === filtro;
      });

      lista.selectAll('*').remove();

      if (!visibles.length) {
        lista
          .append('p')
          .attr('class', 'ct-feed-vacio')
          .text('Sin alertas para este filtro. Cadena de custodia conforme.');
        return;
      }

      var tarjetas = lista
        .selectAll('article')
        .data(visibles)
        .enter()
        .append('article')
        .attr('class', function (a) { return 'ct-alerta ct-alerta--' + a.tipo.toLowerCase(); })
        .attr('tabindex', 0)
        .attr('role', 'button')
        .on('click', function (evento, a) {
          if (opciones.onSelect) opciones.onSelect(a.registro);
        })
        .on('keydown', function (evento, a) {
          if (evento.key === 'Enter' || evento.key === ' ') {
            evento.preventDefault();
            if (opciones.onSelect) opciones.onSelect(a.registro);
          }
        });

      var cab = tarjetas.append('header').attr('class', 'ct-alerta-head');
      cab.append('span').attr('class', 'ct-alerta-tipo').text(function (a) { return a.tipo; });
      cab.append('span').attr('class', 'ct-alerta-meta').text(function (a) {
        return formatearMeta(a.meta);
      });

      tarjetas.append('h4').attr('class', 'ct-alerta-titulo').text(function (a) { return a.titulo; });
      tarjetas.append('p').attr('class', 'ct-alerta-cuerpo').text(function (a) { return a.cuerpo; });
      tarjetas.append('p').attr('class', 'ct-alerta-impacto').text(function (a) { return a.impacto; });
      tarjetas
        .append('p')
        .attr('class', 'ct-alerta-accion')
        .html(function (a) { return '<strong>Accion:</strong> ' + a.accion; });
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
      alertasActuales = generar(registros);
      pintar();
      return alertasActuales;
    }

    return { actualizar: actualizar, generar: generar };
  }

  CT.AlertsFeed = { crear: crear, generar: generar };
})(window);
