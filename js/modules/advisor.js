/* ==========================================================================
   CafeTrace · modules/advisor.js
   --------------------------------------------------------------------------
   Analisis parametrizado del lote ("Ver mas detalles" de cada alerta).

   El feed de alertas muestra solo cuatro bullets: ubicacion, agroquimico,
   exportadora y resultado del test. Todo lo demas -- el porque, el cuanto y
   el que hacer -- vive aqui y se despliega bajo demanda.

   Como funciona: un scorecard determinista. Cada FACTOR pondera una
   caracteristica del lote (severidad del residuo, volumen, mercado destino,
   proximidad a convencional, cobertura del panel, consistencia del dato) y
   suma puntos a un score 0-100 que se traduce en un nivel de prioridad y en
   una lista ordenada de acciones. Es reproducible y auditable: dos corridas
   con el mismo lote dan exactamente el mismo texto, que es lo que exige una
   decision de segregacion que despues se defiende ante un auditor.

   Trabajo futuro (v2): `CT.Advisor.proveedor` es el punto de extension para
   sustituir este scorecard por una recomendacion generada por un LLM. El
   contrato de salida (`{ score, prioridad, factores[], acciones[], notas }`)
   se mantiene igual, de modo que la UI no cambia: solo cambia quien redacta.
   Mientras `proveedor` sea 'reglas', no hay llamada de red y el dashboard
   sigue funcionando sin conexion en el centro de acopio.
   ========================================================================== */
(function (global) {
  'use strict';

  var CT = (global.CT = global.CT || {});

  // Mercados con control reforzado de residuos en cafe organico importado.
  var MERCADOS_ESTRICTOS = [
    'Alemania', 'Belgica', 'Francia', 'Paises_Bajos', 'Italia', 'Espana',
    'Estados_Unidos', 'Japon'
  ];

  var fmtUSD = d3.format(',.0f');

  /** Reduce las etiquetas de resultado a dos clases: hallazgo o conforme. */
  function canonico(resultado) {
    return /alerta|^detectad/i.test(resultado) ? 'HALLAZGO' : 'CONFORME';
  }

  /* ---------------------------------------------------------------------
     FACTORES
     Cada factor devuelve null (no aplica) o un objeto con:
       etiqueta  nombre corto del factor
       detalle   frase que explica que se observo
       puntos    aporte al score (0-100 acumulado, se satura en 100)
     --------------------------------------------------------------------- */
  var FACTORES = [
    {
      id: 'F1_SEVERIDAD_RESIDUO',
      evaluar: function (r) {
        if (!r.Hallazgos.length) return null;
        var h = r.Hallazgo_Principal;

        if (h.Tipo_Lectura === 'Cualitativo') {
          return {
            etiqueta: 'Residuo detectado',
            detalle:
              h.Agroquimico + ' (' + h.Clase.toLowerCase() + ') con lectura ' +
              'cualitativa positiva. El kit confirma presencia pero no cuantifica: ' +
              'en un lote organico la presencia ya es incumplimiento.',
            puntos: 40
          };
        }

        var veces = h.Valor_ppm / h.Umbral_ppm;
        return {
          etiqueta: 'Residuo sobre umbral',
          detalle:
            h.Agroquimico + ' (' + h.Clase.toLowerCase() + ') a ' +
            h.Valor_ppm.toFixed(2) + ' ppm, ' + veces.toFixed(1) + '× el umbral de ' +
            h.Umbral_ppm.toFixed(2) + ' ppm del kit ' + h.Kit + '.',
          puntos: Math.min(50, 25 + veces * 12)
        };
      }
    },
    {
      id: 'F2_MULTIRESIDUO',
      evaluar: function (r) {
        if (r.Hallazgos.length < 2) return null;
        return {
          etiqueta: 'Multiresiduo',
          detalle:
            r.Hallazgos.length + ' agroquimicos distintos por encima de criterio (' +
            r.Agroquimicos_Detectados.join(', ') + '). El patron apunta a aplicacion ' +
            'dirigida o mezcla en equipo compartido, no a deriva puntual.',
          puntos: 15
        };
      }
    },
    {
      id: 'F3_PANEL_INCOMPLETO',
      evaluar: function (r) {
        if (r.Certificacion_Declarada !== 'Organico') return null;
        if (!r.Kits_Faltantes.length) return null;
        var sinNada = r.Kits_Ejecutados === 0;
        return {
          etiqueta: sinNada ? 'Panel sin ejecutar' : 'Panel incompleto',
          detalle: sinNada
            ? 'Ninguno de los ' + r.Kits_Totales + ' kits del panel se corrio sobre ' +
              'este lote. El pasaporte digital no tiene etapa de verificacion.'
            : 'Faltan ' + r.Kits_Faltantes.length + ' de ' + r.Kits_Totales +
              ' kits (' + r.Kits_Faltantes.join(', ') + '). Lo medido esta conforme, ' +
              'pero el lote no queda cubierto frente a esos residuos.',
          puntos: sinNada ? 32 : 18
        };
      }
    },
    {
      id: 'F4_VOLUMEN',
      evaluar: function (r) {
        var tabla = {
          Grande: {
            puntos: 16,
            texto: 'lote grande: compromete un contenedor completo y arrastra a los ' +
                   'demas lotes consolidados con el.'
          },
          Mediano: { puntos: 9, texto: 'lote mediano: perdida acotada pero relevante.' },
          Pequeno: { puntos: 4, texto: 'lote pequeno: exposicion economica limitada.' }
        };
        var t = tabla[r.Tamano_Lote];
        return {
          etiqueta: 'Volumen expuesto',
          detalle: r.Peso_Quintales + ' qq · ' + t.texto,
          puntos: t.puntos
        };
      }
    },
    {
      id: 'F5_MERCADO_DESTINO',
      evaluar: function (r) {
        if (MERCADOS_ESTRICTOS.indexOf(r.Destino) >= 0) {
          return {
            etiqueta: 'Mercado exigente',
            detalle:
              'Destino ' + r.Destino.replace(/_/g, ' ') + ': control reforzado de ' +
              'residuos en frontera. Un rechazo alli deja trazabilidad negativa sobre ' +
              'la exportadora ' + r.Empresa_Exportadora + '.',
            puntos: 12
          };
        }
        if (r.Destino === 'Nacional') {
          return {
            etiqueta: 'Mercado nacional',
            detalle: 'Canal local: sin control de residuos en frontera ni penalizacion UE.',
            puntos: 0
          };
        }
        return {
          etiqueta: 'Destino sin asignar',
          detalle: 'El lote aun no tiene mercado comprometido: hay margen para redirigirlo ' +
                   'sin romper un contrato.',
          puntos: 3
        };
      }
    },
    {
      id: 'F6_PROXIMIDAD',
      evaluar: function (r) {
        if (r.Proximidad_Finca_Convencional !== 'Alta') return null;
        var def = r.Hallazgo_Principal
          ? CT.DataLoader.definicionAgroquimico(r.Hallazgo_Principal.Agroquimico)
          : null;
        return {
          etiqueta: 'Deriva por vecindad',
          detalle:
            'La finca colinda con parcelas convencionales (proximidad Alta). ' +
            (def && def.fuente_deriva
              ? 'Via tipica para ' + r.Hallazgo_Principal.Agroquimico.toLowerCase() +
                ': ' + def.fuente_deriva.toLowerCase()
              : 'La contaminacion puede originarse fuera de la parcela certificada.'),
          puntos: 10
        };
      }
    },
    {
      id: 'F7_DIVERGENCIA_DATO',
      evaluar: function (r) {
        if (!r.Divergencia_Riesgo) return null;
        return {
          etiqueta: 'Dato desactualizado',
          detalle:
            'El registro del lote declara riesgo "' + (r.Riesgo_Declarado || 'vacio') +
            '" y el motor calcula "' + r.Riesgo + '". Alguien puede estar decidiendo ' +
            'sobre la etiqueta vieja.',
          puntos: 8
        };
      }
    },
    {
      id: 'F8_KIT_DECLARADO',
      evaluar: function (r) {
        var discrepantes = r.Tests.filter(function (t) {
          if (!t.Resultado_Declarado) return false;
          // "Detectado" y "Alerta_Contaminacion" son la misma lectura escrita
          // de dos formas (cualitativa y cuantitativa): solo hay discrepancia
          // cuando el operador declaro lo CONTRARIO a lo que da el umbral.
          return canonico(t.Resultado_Declarado) !== canonico(t.Resultado);
        });
        if (!discrepantes.length) return null;
        return {
          etiqueta: 'Lectura mal registrada',
          detalle:
            discrepantes.length + ' kit(s) con resultado declarado distinto al que ' +
            'arroja el umbral (' +
            discrepantes.map(function (t) { return t.Agroquimico; }).join(', ') +
            '). Revisar la digitacion del operador.',
          puntos: 6
        };
      }
    }
  ];

  /* ---------------------------------------------------------------------
     ACCIONES
     Se emiten en orden de ejecucion; cada una declara su condicion.
     --------------------------------------------------------------------- */
  var ACCIONES = [
    {
      cuando: function (r) { return r.Segregado; },
      texto: function (r) {
        return 'Segregar fisicamente los ' + r.Peso_Quintales + ' qq del lote ' +
               r.ID_Lote + ' antes de consolidar el contenedor.';
      }
    },
    {
      cuando: function (r) { return r.Segregado && r.Destino !== 'Nacional'; },
      texto: function (r) {
        return 'Redirigir a mercado convencional local y liberar el cupo de ' +
               r.Destino.replace(/_/g, ' ') + ': evita US$ ' + fmtUSD(r.Ahorro_USD) +
               ' en penalizacion.';
      }
    },
    {
      cuando: function (r) { return r.Kits_Faltantes.length > 0 && r.Certificacion_Declarada === 'Organico'; },
      texto: function (r) {
        return 'Correr los kits faltantes (' + r.Kits_Faltantes.join(', ') +
               ') sobre la muestra de acopio ya tomada.';
      }
    },
    {
      cuando: function (r) { return r.Hallazgos.length > 0; },
      texto: function (r) {
        return 'Notificar a ' + r.Empresa_Exportadora + ' y a ' + r.Nombre +
               ' (' + r.Finca + ') con el pasaporte del lote adjunto.';
      }
    },
    {
      cuando: function (r) { return r.Proximidad_Finca_Convencional === 'Alta'; },
      texto: function () {
        return 'Muestrear los bordes de parcela colindantes en la proxima entrega ' +
               'para separar deriva de aplicacion propia.';
      }
    },
    {
      cuando: function (r) { return r.Divergencia_Riesgo; },
      texto: function (r) {
        return 'Sincronizar el campo Riesgo_Calculado del lote ' + r.ID_Lote +
               ' con el resultado vigente del panel.';
      }
    },
    {
      cuando: function (r) { return r.Riesgo === 'Bajo'; },
      texto: function () {
        return 'Sin accion correctiva: mantener el lote en el flujo de exportacion.';
      }
    }
  ];

  /* ---------------------------------------------------------------------
     Analisis
     --------------------------------------------------------------------- */
  function nivelDe(score) {
    if (score >= 70) return { prioridad: 'Inmediata', clase: 'critica' };
    if (score >= 45) return { prioridad: 'Alta', clase: 'alta' };
    if (score >= 20) return { prioridad: 'Media', clase: 'media' };
    return { prioridad: 'Rutinaria', clase: 'baja' };
  }

  /**
   * Analisis parametrizado de un lote.
   * @param {Object} r Registro unido que emite el DataLoader.
   * @returns {{score:number, prioridad:string, clase:string, factores:Array,
   *            acciones:Array<string>, exposicion:number, notas:string,
   *            proveedor:string}}
   */
  function analizar(r) {
    var factores = FACTORES
      .map(function (f) {
        var out = f.evaluar(r);
        if (out) out.id = f.id;
        return out;
      })
      .filter(Boolean)
      .sort(function (a, b) { return b.puntos - a.puntos; });

    var score = Math.min(
      100,
      Math.round(
        factores.reduce(function (s, f) { return s + f.puntos; }, 0)
      )
    );

    // Un lote fuera del alcance organico no escala aunque sume factores
    // estructurales (volumen, destino): no hay incumplimiento posible.
    if (r.Certificacion_Declarada !== 'Organico') score = Math.min(score, 15);

    var nivel = nivelDe(score);

    var acciones = ACCIONES
      .filter(function (a) { return a.cuando(r); })
      .map(function (a) { return a.texto(r); });

    return {
      score: score,
      prioridad: nivel.prioridad,
      clase: nivel.clase,
      factores: factores,
      acciones: acciones,
      // Exposicion: lo que se pierde si el lote embarca sin corregir.
      exposicion: r.Peso_Quintales * CT.DataLoader.CONFIG.PENALIZACION_USD_POR_QUINTAL,
      ahorro: r.Ahorro_USD,
      notas:
        'Analisis parametrizado por reglas (' + factores.length + ' factores, ' +
        'score ' + score + '/100). Reproducible y auditable. La recomendacion ' +
        'redactada por LLM queda como trabajo futuro.',
      proveedor: CT.Advisor ? CT.Advisor.proveedor : 'reglas'
    };
  }

  CT.Advisor = {
    // 'reglas' hoy; 'llm' en la v2 (ver cabecera del modulo).
    proveedor: 'reglas',
    analizar: analizar,
    FACTORES: FACTORES,
    MERCADOS_ESTRICTOS: MERCADOS_ESTRICTOS
  };
})(window);
