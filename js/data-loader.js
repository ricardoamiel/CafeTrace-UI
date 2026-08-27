/* ==========================================================================
   CafeTrace · data-loader.js
   --------------------------------------------------------------------------
   Responsabilidades del modulo:
     1. Cargar los 3 CSV de forma concurrente (d3.csv + Promise.all).
     2. Hacer el join logico Lote -> Productor -> Test ELISA.
     3. Ejecutar el motor de reglas que calcula el Score de Riesgo.
     4. Emitir el Ledger de auditoria (Pasaporte Digital) en consola.
     5. Persistir los registros que el supervisor agrega desde el formulario
        (localStorage, porque en esta fase no hay backend activo).

   Nota de arquitectura: se usa el patron IIFE + namespace global `CT` en
   lugar de ES modules a proposito. Los ES modules exigen servidor HTTP por
   CORS; con este patron el dashboard tambien abre haciendo doble clic en
   index.html (file://), que es el escenario real de un supervisor de
   cooperativa con una tablet sin conexion en el centro de acopio.
   ========================================================================== */
(function (global) {
  'use strict';

  var CT = (global.CT = global.CT || {});

  /* ---------------------------------------------------------------------
     CONSTANTES DE NEGOCIO
     --------------------------------------------------------------------- */
  var CONFIG = {
    // Limite de deteccion practico del kit de inmunoensayo rapido (ELISA).
    // Por encima de este valor el lote pierde la condicion de organico.
    UMBRAL_GLIFOSATO_PPM: 0.1,

    // Penalizacion de precio en destino (UE). Fuente: Gestion, 15/11/2019.
    // "UE castiga el precio del cafe organico con hasta US$50 por quintal
    //  debido a rastros de glifosato". 1 quintal = 100 kg => US$0.50/kg.
    PENALIZACION_USD_POR_QUINTAL: 50,

    RUTAS: {
      productores: 'data/productores.csv',
      tests: 'data/test_elisa.csv',
      lotes: 'data/lotes_cafe.csv'
    },

    STORAGE_KEY: 'cafetrace.registros.v1'
  };

  /* ---------------------------------------------------------------------
     SEED EMBEBIDO (fallback)
     Si el navegador bloquea fetch() sobre file://, parseamos estas mismas
     cadenas con d3.csvParse. Mantener sincronizado con /data/*.csv.
     --------------------------------------------------------------------- */
  var SEED = {
    productores:
      'ID_Productor,Nombre,Finca,Coordenadas_Lat,Coordenadas_Lon,Certificacion_Declarada,Proximidad_Finca_Convencional\n' +
      'P001,Mateo Quispe,Finca La Aurora,-6.2305,-77.8622,Organico,Alta\n' +
      'P002,Lucia Huaman,Finca El Shambo,-6.2215,-77.8540,Organico,Baja\n' +
      'P003,Juan Mendoza,Finca Las Palmeras,-6.2410,-77.8711,Convencional,N/A\n' +
      'P004,Elena Flores,Finca Vista Hermosa,-6.2350,-77.8590,Organico,Alta\n' +
      'P005,Carlos Ortiz,Finca Bella Vista,-6.2180,-77.8480,Organico,Baja\n' +
      'P006,Rosa Tapia,Finca Los Cedros,-6.2270,-77.8660,Organico,Alta\n',
    tests:
      'ID_Test,ID_Productor,ID_Lote,Glifosato_ppm,Resultado,Timestamp,Operador\n' +
      'T101,P001,L201,0.02,Aprobado,2026-08-20T10:30:00Z,Ricardo\n' +
      'T102,P002,L202,0.00,Aprobado,2026-08-20T11:15:00Z,Juan\n' +
      'T104,P004,L204,0.18,Alerta_Contaminacion,2026-08-21T09:00:00Z,Ricardo\n' +
      'T105,P005,L205,0.01,Aprobado,2026-08-21T14:45:00Z,Juan\n',
    lotes:
      'ID_Lote,ID_Productor,Peso_Quintales,Destino,Estado_Transito,Estado_Seguridad,Riesgo_Calculado\n' +
      'L201,P001,150,Alemania,En_Acopio,Aprobado,Medio\n' +
      'L202,P002,200,Belgica,En_Transito,Aprobado,Bajo\n' +
      'L203,P003,300,Nacional,Vendido_Local,No_Aplica,Alto\n' +
      'L204,P004,80,Pendiente,Segregado_Conventional,Rechazado,Critico\n' +
      'L205,P005,120,Francia,En_Acopio,Aprobado,Bajo\n' +
      'L206,P006,95,Paises_Bajos,En_Acopio,Pendiente_Verificacion,Bajo\n'
  };

  /* ---------------------------------------------------------------------
     PERSISTENCIA LOCAL (altas desde el formulario)
     --------------------------------------------------------------------- */
  function registrosLocalesVacios() {
    return { productores: [], tests: [], lotes: [] };
  }

  function leerLocales() {
    try {
      var raw = global.localStorage.getItem(CONFIG.STORAGE_KEY);
      if (!raw) return registrosLocalesVacios();
      var parsed = JSON.parse(raw);
      return {
        productores: parsed.productores || [],
        tests: parsed.tests || [],
        lotes: parsed.lotes || []
      };
    } catch (e) {
      // Modo privado, storage deshabilitado o JSON corrupto: seguimos sin locales.
      console.warn('[CafeTrace] localStorage no disponible, se ignoran altas locales.', e);
      return registrosLocalesVacios();
    }
  }

  function guardarLocales(locales) {
    try {
      global.localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(locales));
      return true;
    } catch (e) {
      console.warn('[CafeTrace] No se pudo persistir en localStorage.', e);
      return false;
    }
  }

  /**
   * Agrega un registro nuevo (productor | test | lote) al almacenamiento local.
   * @param {'productores'|'tests'|'lotes'} coleccion
   * @param {Object} registro  Objeto con las mismas columnas que el CSV.
   */
  function agregarRegistro(coleccion, registro) {
    var locales = leerLocales();
    locales[coleccion].push(registro);
    guardarLocales(locales);
    return locales;
  }

  /** Borra todas las altas locales y vuelve al dataset semilla. */
  function limpiarRegistrosLocales() {
    guardarLocales(registrosLocalesVacios());
  }

  /* ---------------------------------------------------------------------
     CARGA CONCURRENTE
     --------------------------------------------------------------------- */

  /**
   * Intenta d3.csv() sobre la ruta real; si falla (CORS con file://, 404,
   * offline) cae al seed embebido usando d3.csvParse. Nunca rechaza:
   * el dashboard siempre tiene datos que mostrar.
   */
  function cargarCSVConFallback(ruta, seedTexto, etiqueta) {
    // Promise.resolve().then(...) envuelve la llamada: si d3.csv lanza de
    // forma SINCRONA (p.ej. entorno sin fetch), el throw se convierte en
    // rechazo y el .catch de abajo si puede activar el fallback.
    return Promise.resolve()
      .then(function () {
        return d3.csv(ruta);
      })
      .then(function (filas) {
        if (!filas || !filas.length) throw new Error('CSV vacio');
        return { filas: filas, origen: 'fetch' };
      })
      .catch(function (err) {
        console.warn(
          '[CafeTrace] No se pudo leer ' + ruta + ' (' + etiqueta + '). ' +
            'Se usa el dataset embebido. Motivo: ' + err.message
        );
        return { filas: d3.csvParse(seedTexto), origen: 'seed-embebido' };
      });
  }

  /**
   * Carga los tres CSV en paralelo y mezcla las altas locales del supervisor.
   * @returns {Promise<{productores:Array, tests:Array, lotes:Array, origen:Object}>}
   */
  function cargarCrudos() {
    return Promise.all([
      cargarCSVConFallback(CONFIG.RUTAS.productores, SEED.productores, 'productores'),
      cargarCSVConFallback(CONFIG.RUTAS.tests, SEED.tests, 'test_elisa'),
      cargarCSVConFallback(CONFIG.RUTAS.lotes, SEED.lotes, 'lotes_cafe')
    ]).then(function (res) {
      var locales = leerLocales();
      return {
        productores: res[0].filas.concat(locales.productores),
        tests: res[1].filas.concat(locales.tests),
        lotes: res[2].filas.concat(locales.lotes),
        origen: {
          productores: res[0].origen,
          tests: res[1].origen,
          lotes: res[2].origen,
          altasLocales:
            locales.productores.length + locales.tests.length + locales.lotes.length
        }
      };
    });
  }

  /* ---------------------------------------------------------------------
     NORMALIZACION DE TIPOS
     --------------------------------------------------------------------- */
  function normalizarProductor(p) {
    return {
      ID_Productor: (p.ID_Productor || '').trim(),
      Nombre: (p.Nombre || '').trim(),
      Finca: (p.Finca || '').trim(),
      lat: +p.Coordenadas_Lat,
      lon: +p.Coordenadas_Lon,
      Certificacion_Declarada: (p.Certificacion_Declarada || '').trim(),
      Proximidad_Finca_Convencional: (p.Proximidad_Finca_Convencional || 'N/A').trim()
    };
  }

  function normalizarTest(t) {
    return {
      ID_Test: (t.ID_Test || '').trim(),
      ID_Productor: (t.ID_Productor || '').trim(),
      ID_Lote: (t.ID_Lote || '').trim(),
      Glifosato_ppm: +t.Glifosato_ppm,
      Resultado: (t.Resultado || '').trim(),
      Timestamp: (t.Timestamp || '').trim(),
      Operador: (t.Operador || '').trim()
    };
  }

  function normalizarLote(l) {
    return {
      ID_Lote: (l.ID_Lote || '').trim(),
      ID_Productor: (l.ID_Productor || '').trim(),
      Peso_Quintales: +l.Peso_Quintales,
      Destino: (l.Destino || '').trim(),
      Estado_Transito: (l.Estado_Transito || '').trim(),
      Estado_Seguridad: (l.Estado_Seguridad || '').trim(),
      Riesgo_Declarado: (l.Riesgo_Calculado || '').trim() // valor que trae el CSV
    };
  }

  /* ---------------------------------------------------------------------
     MOTOR DE REGLAS (Rule Engine)
     Evalua en cascada, primera regla que dispara gana. Cada regla devuelve
     nivel de riesgo, motivo legible y accion recomendada operativa.
     --------------------------------------------------------------------- */
  var REGLAS = [
    {
      id: 'R0_NO_ORGANICO',
      test: function (ctx) {
        return ctx.certificacion !== 'Organico';
      },
      salida: function (ctx) {
        return {
          riesgo: 'No aplica',
          motivo:
            'Lote declarado ' + (ctx.certificacion || 'sin certificacion') +
            '. Fuera del alcance de verificacion organica.',
          accion: 'Comercializar por canal convencional. No consume kit ELISA.'
        };
      }
    },
    {
      id: 'R1_GLIFOSATO_SOBRE_UMBRAL',
      test: function (ctx) {
        return ctx.tieneTest && ctx.ppm > CONFIG.UMBRAL_GLIFOSATO_PPM;
      },
      salida: function (ctx) {
        return {
          riesgo: 'Critico',
          motivo:
            'Certificacion Organica declarada pero ELISA registra ' +
            ctx.ppm.toFixed(2) + ' ppm de glifosato (umbral ' +
            CONFIG.UMBRAL_GLIFOSATO_PPM + ' ppm).',
          accion:
            'SEGREGAR el lote de inmediato y redirigir a mercado convencional local. ' +
            'Evita penalizacion de US$' + CONFIG.PENALIZACION_USD_POR_QUINTAL +
            '/quintal en destino UE y el riesgo de descertificacion de la cooperativa.'
        };
      }
    },
    {
      id: 'R2_ORGANICO_SIN_TEST',
      test: function (ctx) {
        return !ctx.tieneTest;
      },
      salida: function () {
        return {
          riesgo: 'Alto',
          motivo:
            'Inconsistencia de trazabilidad: lote organico sin resultado ELISA asociado. ' +
            'El pasaporte digital esta incompleto.',
          accion:
            'Bloquear consolidacion para exportacion y ejecutar test ELISA en acopio ' +
            'antes del embarque.'
        };
      }
    },
    {
      id: 'R3_DERIVA_POTENCIAL',
      test: function (ctx) {
        return (
          ctx.tieneTest &&
          ctx.ppm <= CONFIG.UMBRAL_GLIFOSATO_PPM &&
          ctx.proximidad === 'Alta'
        );
      },
      salida: function (ctx) {
        return {
          riesgo: 'Medio',
          motivo:
            'ELISA conforme (' + ctx.ppm.toFixed(2) + ' ppm) pero la finca colinda con ' +
            'parcelas convencionales (proximidad Alta): riesgo de deriva de agroquimicos.',
          accion:
            'Monitorear: re-testear en la siguiente entrega y priorizar muestreo en ' +
            'los bordes de parcela colindantes.'
        };
      }
    },
    {
      id: 'R4_CONFORME',
      test: function () {
        return true; // regla por defecto
      },
      salida: function (ctx) {
        return {
          riesgo: 'Bajo',
          motivo:
            'ELISA conforme (' + ctx.ppm.toFixed(2) + ' ppm) y sin proximidad ' +
            'critica a parcelas convencionales.',
          accion: 'Continuar flujo de exportacion con pasaporte digital completo.'
        };
      }
    }
  ];

  /**
   * Evalua el motor de reglas sobre un registro ya unido.
   * @returns {{riesgo:string, motivo:string, accion:string, regla:string}}
   */
  function evaluarRiesgo(ctx) {
    for (var i = 0; i < REGLAS.length; i++) {
      if (REGLAS[i].test(ctx)) {
        var out = REGLAS[i].salida(ctx);
        out.regla = REGLAS[i].id;
        return out;
      }
    }
    // Inalcanzable: R4 siempre dispara.
    return { riesgo: 'Bajo', motivo: '', accion: '', regla: 'R4_CONFORME' };
  }

  /* ---------------------------------------------------------------------
     JOIN LOGICO  Lote -> Productor -> Test
     --------------------------------------------------------------------- */

  /**
   * Une los tres datasets y aplica el motor de reglas.
   * El lote es la entidad central: un lote sin productor valido se descarta
   * (inner join), pero un lote sin test SI se conserva, porque justamente esa
   * ausencia es lo que la regla R2 debe detectar (left join sobre tests).
   */
  function unirYEvaluar(crudos) {
    var productores = crudos.productores.map(normalizarProductor);
    var tests = crudos.tests.map(normalizarTest);
    var lotes = crudos.lotes.map(normalizarLote);

    var mapaProductores = new Map(
      productores.map(function (p) {
        return [p.ID_Productor, p];
      })
    );

    // Si hubiera mas de un test por lote nos quedamos con el mas reciente.
    var mapaTests = new Map();
    tests.forEach(function (t) {
      if (!t.ID_Lote) return;
      var previo = mapaTests.get(t.ID_Lote);
      if (!previo || String(t.Timestamp) > String(previo.Timestamp)) {
        mapaTests.set(t.ID_Lote, t);
      }
    });

    var huerfanos = [];

    var registros = lotes
      .map(function (lote) {
        var productor = mapaProductores.get(lote.ID_Productor);
        if (!productor) {
          huerfanos.push(lote.ID_Lote);
          return null; // inner join: sin origen no hay pasaporte posible
        }

        var test = mapaTests.get(lote.ID_Lote) || null;
        var ctx = {
          certificacion: productor.Certificacion_Declarada,
          proximidad: productor.Proximidad_Finca_Convencional,
          tieneTest: !!test,
          ppm: test ? test.Glifosato_ppm : null
        };

        var evaluacion = evaluarRiesgo(ctx);
        var segregado = evaluacion.riesgo === 'Critico';

        return {
          // --- identidad
          ID_Lote: lote.ID_Lote,
          ID_Productor: productor.ID_Productor,
          ID_Test: test ? test.ID_Test : null,

          // --- origen
          Nombre: productor.Nombre,
          Finca: productor.Finca,
          lat: productor.lat,
          lon: productor.lon,
          Certificacion_Declarada: productor.Certificacion_Declarada,
          Proximidad_Finca_Convencional: productor.Proximidad_Finca_Convencional,

          // --- verificacion
          Glifosato_ppm: test ? test.Glifosato_ppm : null,
          Resultado_ELISA: test ? test.Resultado : 'Sin_Test',
          Timestamp: test ? test.Timestamp : null,
          Operador: test ? test.Operador : null,

          // --- lote
          Peso_Quintales: lote.Peso_Quintales,
          Destino: lote.Destino,
          Estado_Transito: lote.Estado_Transito,
          Estado_Seguridad: lote.Estado_Seguridad,

          // --- evaluacion en tiempo de ejecucion
          Riesgo: evaluacion.riesgo,
          Riesgo_Declarado: lote.Riesgo_Declarado,
          Motivo: evaluacion.motivo,
          Accion: evaluacion.accion,
          Regla: evaluacion.regla,
          Segregado: segregado,

          // Divergencia entre lo que el CSV declara y lo que el motor calcula:
          // es en si misma una inconsistencia de trazabilidad reportable.
          Divergencia_Riesgo:
            normalizarEtiquetaRiesgo(lote.Riesgo_Declarado) !==
            normalizarEtiquetaRiesgo(evaluacion.riesgo),

          // Ahorro que se materializa solo si el lote se segrega a tiempo.
          Ahorro_USD: segregado
            ? lote.Peso_Quintales * CONFIG.PENALIZACION_USD_POR_QUINTAL
            : 0
        };
      })
      .filter(Boolean);

    if (huerfanos.length) {
      console.warn(
        '[CafeTrace] Lotes descartados por productor inexistente: ' + huerfanos.join(', ')
      );
    }

    return registros;
  }

  /** "Critico" / "critico" / "Crítico" -> "critico" */
  function normalizarEtiquetaRiesgo(valor) {
    return String(valor || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[_\s]+/g, ' ')
      .trim();
  }

  /* ---------------------------------------------------------------------
     KPIs
     --------------------------------------------------------------------- */
  function calcularKPIs(registros) {
    var organicos = registros.filter(function (r) {
      return r.Certificacion_Declarada === 'Organico';
    });
    var organicosTesteados = organicos.filter(function (r) {
      return r.ID_Test !== null;
    });
    var criticos = registros.filter(function (r) {
      return r.Segregado;
    });

    var quintalesTotales = d3.sum(registros, function (r) {
      return r.Peso_Quintales;
    });
    var quintalesOrganicos = d3.sum(organicos, function (r) {
      return r.Peso_Quintales;
    });
    var quintalesSegregados = d3.sum(criticos, function (r) {
      return r.Peso_Quintales;
    });

    // Tasa de contaminacion cruzada: sobre la base testeada, que es la unica
    // poblacion en la que la contaminacion es efectivamente observable.
    var tasa = organicosTesteados.length
      ? (criticos.length / organicosTesteados.length) * 100
      : 0;

    return {
      quintalesTotales: quintalesTotales,
      quintalesOrganicos: quintalesOrganicos,
      quintalesSegregados: quintalesSegregados,
      lotesTotales: registros.length,
      lotesOrganicos: organicos.length,
      lotesOrganicosTesteados: organicosTesteados.length,
      lotesCriticos: criticos.length,
      lotesSinTest: organicos.length - organicosTesteados.length,
      tasaContaminacion: tasa,
      coberturaTesteo: organicos.length
        ? (organicosTesteados.length / organicos.length) * 100
        : 0,
      ahorroUSD: quintalesSegregados * CONFIG.PENALIZACION_USD_POR_QUINTAL,
      penalizacionPorQuintal: CONFIG.PENALIZACION_USD_POR_QUINTAL
    };
  }

  /* ---------------------------------------------------------------------
     LEDGER DE AUDITORIA (Pasaporte Digital)
     Log estructurado JSON, verificable de punta a punta:
     Origen -> Verificacion -> Consolidacion -> Decision.
     --------------------------------------------------------------------- */
  function construirLedger(registros, kpis, origen) {
    return {
      ledger: 'CafeTrace::PasaporteDigital',
      version: '1.0.0-MVP',
      emitido_en: new Date().toISOString(),
      fuente_datos: origen,
      parametros: {
        umbral_glifosato_ppm: CONFIG.UMBRAL_GLIFOSATO_PPM,
        penalizacion_usd_quintal: CONFIG.PENALIZACION_USD_POR_QUINTAL,
        referencia_penalizacion:
          'Gestion (2019-11-15): la UE castiga el cafe organico con hasta US$50/quintal por rastros de glifosato.'
      },
      resumen: kpis,
      pasaportes: registros.map(function (r) {
        return {
          id_pasaporte: r.ID_Lote + '::' + r.ID_Productor + '::' + (r.ID_Test || 'SIN_TEST'),
          cadena: [
            {
              etapa: '1_ORIGEN',
              entidad: r.Finca,
              productor: r.Nombre,
              id: r.ID_Productor,
              geo: { lat: r.lat, lon: r.lon },
              certificacion_declarada: r.Certificacion_Declarada,
              proximidad_convencional: r.Proximidad_Finca_Convencional
            },
            {
              etapa: '2_VERIFICACION_ELISA',
              id: r.ID_Test,
              glifosato_ppm: r.Glifosato_ppm,
              resultado: r.Resultado_ELISA,
              timestamp: r.Timestamp,
              operador: r.Operador,
              verificado: r.ID_Test !== null
            },
            {
              etapa: '3_CONSOLIDACION_LOTE',
              id: r.ID_Lote,
              peso_quintales: r.Peso_Quintales,
              destino: r.Destino,
              estado_transito: r.Estado_Transito,
              estado_seguridad: r.Estado_Seguridad
            },
            {
              etapa: '4_DECISION_MOTOR_REGLAS',
              regla_disparada: r.Regla,
              riesgo_calculado: r.Riesgo,
              riesgo_declarado_csv: r.Riesgo_Declarado,
              divergencia: r.Divergencia_Riesgo,
              motivo: r.Motivo,
              accion_recomendada: r.Accion,
              segregado: r.Segregado,
              ahorro_estimado_usd: r.Ahorro_USD
            }
          ]
        };
      })
    };
  }

  /* ---------------------------------------------------------------------
     API PUBLICA
     --------------------------------------------------------------------- */

  /**
   * Punto de entrada del pipeline completo.
   * @returns {Promise<{registros:Array, kpis:Object, ledger:Object, crudos:Object}>}
   */
  function load() {
    return cargarCrudos().then(function (crudos) {
      var registros = unirYEvaluar(crudos);
      var kpis = calcularKPIs(registros);
      var ledger = construirLedger(registros, kpis, crudos.origen);

      console.groupCollapsed(
        '%c[CafeTrace] Ledger del Pasaporte Digital · ' + registros.length + ' lotes trazados',
        'color:#6b7f4e;font-weight:bold'
      );
      console.log(JSON.stringify(ledger, null, 2));
      console.groupEnd();

      return { registros: registros, kpis: kpis, ledger: ledger, crudos: crudos };
    });
  }

  CT.DataLoader = {
    CONFIG: CONFIG,
    load: load,
    agregarRegistro: agregarRegistro,
    limpiarRegistrosLocales: limpiarRegistrosLocales,
    leerLocales: leerLocales,
    evaluarRiesgo: evaluarRiesgo,
    calcularKPIs: calcularKPIs
  };
})(window);
