/* ==========================================================================
   CafeTrace · data-loader.js
   --------------------------------------------------------------------------
   Responsabilidades del modulo:
     1. Cargar los 3 CSV de forma concurrente (d3.csv + Promise.all).
     2. Hacer el join logico Lote -> Productor -> Panel de tests ELISA.
     3. Ejecutar el motor de reglas que calcula el Score de Riesgo.
     4. Emitir el Ledger de auditoria (Pasaporte Digital) en consola.
     5. Persistir los registros que el supervisor agrega desde el formulario
        (localStorage, porque en esta fase no hay backend activo).

   Panel multi-kit (v1.1): el MVP verificaba solo glifosato. La plataforma
   no innova el inmunoensayo, innova su USO: se declara un PANEL de cuatro
   kits ELISA comerciales (glifosato + 3 de los agroquimicos mas comunes en
   cafe) y cada lote se evalua contra el panel completo. Un lote no es
   "verificado" por tener un test, sino por tener el panel cerrado.

   Cada kit reporta una de las dos lecturas que admite un ELISA real:
     - Cuantitativo: concentracion en ppm, se compara contra el umbral.
     - Cualitativo:  presencia / ausencia (deteccion binaria). En un lote
       declarado organico cualquier deteccion cualitativa es un hallazgo.

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
     PANEL DE AGROQUIMICOS
     Umbrales alineados al criterio de tolerancia cero de la certificacion
     organica: el limite operativo es el limite de deteccion practico del
     kit, no el LMR convencional de la UE (que es mas permisivo).
     --------------------------------------------------------------------- */
  var PANEL = [
    {
      nombre: 'Glifosato',
      clase: 'Herbicida',
      kit: 'ELISA_GLY_96',
      lectura: 'Cuantitativo',
      umbral_ppm: 0.10,
      fuente_deriva: 'Aplicacion en linderos y caminos de parcelas convencionales.'
    },
    {
      nombre: 'Clorpirifos',
      clase: 'Insecticida organofosforado',
      kit: 'ELISA_CPF_96',
      lectura: 'Cuantitativo',
      umbral_ppm: 0.05,
      fuente_deriva: 'Control de broca en parcelas vecinas; deriva por aspersion.'
    },
    {
      nombre: 'Cipermetrina',
      clase: 'Insecticida piretroide',
      kit: 'ELISA_PYR_48',
      lectura: 'Cualitativo',
      umbral_ppm: null,
      fuente_deriva: 'Mochila aspersora compartida entre productores.'
    },
    {
      nombre: 'Carbendazim',
      clase: 'Fungicida bencimidazol',
      kit: 'ELISA_CBZ_96',
      lectura: 'Cuantitativo',
      umbral_ppm: 0.10,
      fuente_deriva: 'Control de roya; contaminacion cruzada en secado y almacen.'
    }
  ];

  var PANEL_POR_NOMBRE = new Map(
    PANEL.map(function (a) { return [a.nombre, a]; })
  );

  /* ---------------------------------------------------------------------
     CONSTANTES DE NEGOCIO
     --------------------------------------------------------------------- */
  var CONFIG = {
    // Panel de kits ELISA que debe cerrarse por lote organico.
    PANEL: PANEL,

    // Compatibilidad: umbral del kit de glifosato, el kit de referencia.
    UMBRAL_GLIFOSATO_PPM: 0.10,

    // Penalizacion de precio en destino (UE). Fuente: Gestion, 15/11/2019.
    // "UE castiga el precio del cafe organico con hasta US$50 por quintal
    //  debido a rastros de glifosato". 1 quintal = 100 kg => US$0.50/kg.
    PENALIZACION_USD_POR_QUINTAL: 50,

    // Cortes de tamano de lote (quintales). Se usan como filtro operativo:
    // un lote grande contaminado compromete un contenedor completo.
    CORTES_TAMANO: { pequeno: 100, mediano: 200 },

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
      'ID_Productor,Nombre,Finca,Coordenadas_Lat,Coordenadas_Lon,Certificacion_Declarada,Proximidad_Finca_Convencional,Empresa_Exportadora\n' +
      'P001,Mateo Quispe,Finca La Aurora,-6.2305,-77.8622,Organico,Alta,Perhusa\n' +
      'P002,Lucia Huaman,Finca El Shambo,-6.2215,-77.8540,Organico,Baja,Coop. Norandino\n' +
      'P003,Juan Mendoza,Finca Las Palmeras,-6.2410,-77.8711,Convencional,N/A,Cenfrocafe\n' +
      'P004,Elena Flores,Finca Vista Hermosa,-6.2350,-77.8590,Organico,Alta,Perhusa\n' +
      'P005,Carlos Ortiz,Finca Bella Vista,-6.2180,-77.8480,Organico,Baja,Olam Peru\n' +
      'P006,Rosa Tapia,Finca Los Cedros,-6.2270,-77.8660,Organico,Alta,Coop. Norandino\n',
    tests:
      'ID_Test,ID_Productor,ID_Lote,Agroquimico,Kit,Tipo_Lectura,Valor_ppm,Resultado,Timestamp,Operador\n' +
      'T101,P001,L201,Glifosato,ELISA_GLY_96,Cuantitativo,0.02,Aprobado,2026-08-20T10:30:00Z,Ricardo\n' +
      'T102,P001,L201,Clorpirifos,ELISA_CPF_96,Cuantitativo,0.01,Aprobado,2026-08-20T10:40:00Z,Ricardo\n' +
      'T103,P001,L201,Cipermetrina,ELISA_PYR_48,Cualitativo,,No_Detectado,2026-08-20T10:50:00Z,Ricardo\n' +
      'T104,P001,L201,Carbendazim,ELISA_CBZ_96,Cuantitativo,0.03,Aprobado,2026-08-20T11:00:00Z,Ricardo\n' +
      'T105,P002,L202,Glifosato,ELISA_GLY_96,Cuantitativo,0.00,Aprobado,2026-08-20T11:15:00Z,Juan\n' +
      'T106,P002,L202,Clorpirifos,ELISA_CPF_96,Cuantitativo,0.00,Aprobado,2026-08-20T11:25:00Z,Juan\n' +
      'T107,P002,L202,Cipermetrina,ELISA_PYR_48,Cualitativo,,No_Detectado,2026-08-20T11:35:00Z,Juan\n' +
      'T108,P002,L202,Carbendazim,ELISA_CBZ_96,Cuantitativo,0.01,Aprobado,2026-08-20T11:45:00Z,Juan\n' +
      'T109,P004,L204,Glifosato,ELISA_GLY_96,Cuantitativo,0.18,Alerta_Contaminacion,2026-08-21T09:00:00Z,Ricardo\n' +
      'T110,P004,L204,Clorpirifos,ELISA_CPF_96,Cuantitativo,0.02,Aprobado,2026-08-21T09:10:00Z,Ricardo\n' +
      'T111,P004,L204,Cipermetrina,ELISA_PYR_48,Cualitativo,,Detectado,2026-08-21T09:20:00Z,Ricardo\n' +
      'T112,P004,L204,Carbendazim,ELISA_CBZ_96,Cuantitativo,0.04,Aprobado,2026-08-21T09:30:00Z,Ricardo\n' +
      'T113,P005,L205,Glifosato,ELISA_GLY_96,Cuantitativo,0.01,Aprobado,2026-08-21T14:45:00Z,Juan\n' +
      'T114,P005,L205,Clorpirifos,ELISA_CPF_96,Cuantitativo,0.07,Alerta_Contaminacion,2026-08-21T14:55:00Z,Juan\n' +
      'T115,P005,L205,Cipermetrina,ELISA_PYR_48,Cualitativo,,No_Detectado,2026-08-21T15:05:00Z,Juan\n' +
      'T116,P005,L205,Carbendazim,ELISA_CBZ_96,Cuantitativo,0.02,Aprobado,2026-08-21T15:15:00Z,Juan\n' +
      'T117,P006,L206,Glifosato,ELISA_GLY_96,Cuantitativo,0.03,Aprobado,2026-08-22T08:10:00Z,Ricardo\n' +
      'T118,P006,L206,Cipermetrina,ELISA_PYR_48,Cualitativo,,No_Detectado,2026-08-22T08:20:00Z,Ricardo\n',
    lotes:
      'ID_Lote,ID_Productor,Peso_Quintales,Destino,Estado_Transito,Estado_Seguridad,Riesgo_Calculado\n' +
      'L201,P001,150,Alemania,En_Acopio,Aprobado,Medio\n' +
      'L202,P002,200,Belgica,En_Transito,Aprobado,Bajo\n' +
      'L203,P003,300,Nacional,Vendido_Local,No_Aplica,Alto\n' +
      'L204,P004,80,Pendiente,Segregado_Conventional,Rechazado,Critico\n' +
      'L205,P005,120,Francia,En_Acopio,Aprobado,Bajo\n' +
      'L206,P006,95,Paises_Bajos,En_Acopio,Pendiente_Verificacion,Alto\n' +
      'L207,P002,110,Estados_Unidos,En_Acopio,Pendiente_Verificacion,Alto\n'
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
  // Sello de la lectura en curso. El tablero recarga los CSV despues de
  // cada alta, y sin esto el navegador devuelve la copia cacheada y la fila
  // recien escrita no aparece hasta refrescar a mano.
  var selloLectura = 0;

  function conSello(ruta) {
    if (global.location.protocol === 'file:') return ruta;
    return ruta + (ruta.indexOf('?') >= 0 ? '&' : '?') + 'v=' + selloLectura;
  }

  function cargarCSVConFallback(ruta, seedTexto, etiqueta) {
    // Promise.resolve().then(...) envuelve la llamada: si d3.csv lanza de
    // forma SINCRONA (p.ej. entorno sin fetch), el throw se convierte en
    // rechazo y el .catch de abajo si puede activar el fallback.
    return Promise.resolve()
      .then(function () {
        return d3.csv(conSello(ruta));
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
    selloLectura = Date.now();
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
      Proximidad_Finca_Convencional: (p.Proximidad_Finca_Convencional || 'N/A').trim(),
      Empresa_Exportadora: (p.Empresa_Exportadora || 'Sin asignar').trim()
    };
  }

  /**
   * Normaliza un resultado de kit. El motor NO confia en la columna
   * `Resultado` del CSV: la recalcula contra el umbral del panel y guarda
   * la declarada aparte, porque la divergencia entre ambas es en si misma
   * un hallazgo de auditoria.
   */
  function normalizarTest(t) {
    var nombre = (t.Agroquimico || 'Glifosato').trim();
    var def = PANEL_POR_NOMBRE.get(nombre) || {
      nombre: nombre,
      clase: 'No catalogado',
      kit: (t.Kit || 'ELISA generico').trim(),
      lectura: 'Cuantitativo',
      umbral_ppm: CONFIG.UMBRAL_GLIFOSATO_PPM
    };

    var lectura = (t.Tipo_Lectura || def.lectura || 'Cuantitativo').trim();
    var crudo = String(t.Valor_ppm === undefined ? '' : t.Valor_ppm).trim();
    var valor = crudo === '' ? null : +crudo;
    if (valor !== null && isNaN(valor)) valor = null;

    var declarado = (t.Resultado || '').trim();
    var detectado, excede;

    if (lectura === 'Cualitativo') {
      // Lectura binaria: el kit solo dice si hay o no hay. En un lote
      // organico la presencia ya es incumplimiento, no hay margen de umbral.
      detectado = /^detectad/i.test(declarado) || /alerta/i.test(declarado);
      excede = detectado;
    } else {
      detectado = valor !== null && valor > 0;
      excede = valor !== null && def.umbral_ppm !== null && valor > def.umbral_ppm;
    }

    return {
      ID_Test: (t.ID_Test || '').trim(),
      ID_Productor: (t.ID_Productor || '').trim(),
      ID_Lote: (t.ID_Lote || '').trim(),
      Agroquimico: nombre,
      Clase: def.clase,
      Kit: (t.Kit || def.kit).trim(),
      Tipo_Lectura: lectura,
      Valor_ppm: valor,
      Umbral_ppm: def.umbral_ppm,
      Resultado_Declarado: declarado,
      Resultado: excede ? 'Alerta_Contaminacion' : 'Aprobado',
      Detectado: detectado,
      Excede: excede,
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

  /** Categoria de tamano usada por el filtro del mapa. */
  function tamanoDeLote(quintales) {
    if (quintales < CONFIG.CORTES_TAMANO.pequeno) return 'Pequeno';
    if (quintales < CONFIG.CORTES_TAMANO.mediano) return 'Mediano';
    return 'Grande';
  }

  /** Departamento que contiene la finca, si la geometria esta disponible. */
  function departamentoDe(lon, lat) {
    var geo = global.CT_PERU_GEO;
    if (!geo || typeof d3.geoContains !== 'function') return null;
    for (var i = 0; i < geo.features.length; i++) {
      if (d3.geoContains(geo.features[i], [lon, lat])) {
        return geo.features[i].properties.dep;
      }
    }
    return null;
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
          accion: 'Comercializar por canal convencional. No consume kits del panel.'
        };
      }
    },
    {
      id: 'R1_RESIDUO_SOBRE_UMBRAL',
      test: function (ctx) {
        return ctx.hallazgos.length > 0;
      },
      salida: function (ctx) {
        return {
          riesgo: 'Critico',
          motivo:
            'Certificacion Organica declarada pero el panel ELISA detecta ' +
            listarHallazgos(ctx.hallazgos) + '.',
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
        return ctx.tests.length === 0;
      },
      salida: function () {
        return {
          riesgo: 'Alto',
          motivo:
            'Inconsistencia de trazabilidad: lote organico sin ningun resultado ELISA ' +
            'asociado. El pasaporte digital esta vacio.',
          accion:
            'Bloquear consolidacion para exportacion y correr el panel completo de ' +
            PANEL.length + ' kits en acopio antes del embarque.'
        };
      }
    },
    {
      id: 'R3_PANEL_INCOMPLETO',
      test: function (ctx) {
        return ctx.faltantes.length > 0;
      },
      salida: function (ctx) {
        return {
          riesgo: 'Alto',
          motivo:
            'Panel de verificacion incompleto: faltan ' + ctx.faltantes.length +
            ' de ' + PANEL.length + ' kits (' + ctx.faltantes.join(', ') + '). ' +
            'Lo ya medido esta conforme, pero el lote no queda cubierto.',
          accion:
            'Correr los kits faltantes (' + ctx.faltantes.join(', ') + ') sobre la ' +
            'misma muestra de acopio antes de liberar el lote.'
        };
      }
    },
    {
      id: 'R4_DERIVA_POTENCIAL',
      test: function (ctx) {
        return ctx.proximidad === 'Alta';
      },
      salida: function (ctx) {
        return {
          riesgo: 'Medio',
          motivo:
            'Panel completo y conforme (' + ctx.tests.length + '/' + PANEL.length +
            ' kits) pero la finca colinda con parcelas convencionales ' +
            '(proximidad Alta): riesgo de deriva de agroquimicos.',
          accion:
            'Monitorear: re-testear en la siguiente entrega y priorizar muestreo en ' +
            'los bordes de parcela colindantes.'
        };
      }
    },
    {
      id: 'R5_CONFORME',
      test: function () {
        return true; // regla por defecto
      },
      salida: function (ctx) {
        return {
          riesgo: 'Bajo',
          motivo:
            'Panel completo y conforme (' + ctx.tests.length + '/' + PANEL.length +
            ' kits) y sin proximidad critica a parcelas convencionales.',
          accion: 'Continuar flujo de exportacion con pasaporte digital completo.'
        };
      }
    }
  ];

  /** "Glifosato 0.18 ppm y Cipermetrina (deteccion cualitativa)" */
  function listarHallazgos(hallazgos) {
    return hallazgos
      .map(function (h) {
        return h.Tipo_Lectura === 'Cualitativo'
          ? h.Agroquimico + ' (deteccion cualitativa)'
          : h.Agroquimico + ' ' + h.Valor_ppm.toFixed(2) + ' ppm (umbral ' +
            h.Umbral_ppm + ')';
      })
      .join(' y ');
  }

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
    // Inalcanzable: R5 siempre dispara.
    return { riesgo: 'Bajo', motivo: '', accion: '', regla: 'R5_CONFORME' };
  }

  /* ---------------------------------------------------------------------
     JOIN LOGICO  Lote -> Productor -> Panel de tests
     --------------------------------------------------------------------- */

  /**
   * Une los tres datasets y aplica el motor de reglas.
   * El lote es la entidad central: un lote sin productor valido se descarta
   * (inner join), pero un lote sin tests SI se conserva, porque justamente
   * esa ausencia es lo que la regla R2 debe detectar (left join sobre tests).
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

    // Un lote tiene ahora N resultados (uno por kit). Si un mismo kit se
    // corre dos veces sobre el mismo lote (re-test), gana el mas reciente:
    // la clave del indice es lote + agroquimico, no solo lote.
    var mapaTests = new Map();
    tests.forEach(function (t) {
      if (!t.ID_Lote) return;
      var clave = t.ID_Lote + '::' + t.Agroquimico;
      var previo = mapaTests.get(clave);
      if (!previo || String(t.Timestamp) > String(previo.Timestamp)) {
        mapaTests.set(clave, t);
      }
    });

    var testsPorLote = new Map();
    mapaTests.forEach(function (t) {
      if (!testsPorLote.has(t.ID_Lote)) testsPorLote.set(t.ID_Lote, []);
      testsPorLote.get(t.ID_Lote).push(t);
    });

    var huerfanos = [];

    var registros = lotes
      .map(function (lote) {
        var productor = mapaProductores.get(lote.ID_Productor);
        if (!productor) {
          huerfanos.push(lote.ID_Lote);
          return null; // inner join: sin origen no hay pasaporte posible
        }

        var panelLote = ordenarPorPanel(testsPorLote.get(lote.ID_Lote) || []);
        var ejecutados = new Set(
          panelLote.map(function (t) { return t.Agroquimico; })
        );
        var faltantes = PANEL
          .map(function (a) { return a.nombre; })
          .filter(function (n) { return !ejecutados.has(n); });

        var hallazgos = panelLote.filter(function (t) { return t.Excede; });

        var ctx = {
          certificacion: productor.Certificacion_Declarada,
          proximidad: productor.Proximidad_Finca_Convencional,
          tests: panelLote,
          hallazgos: hallazgos,
          faltantes: faltantes,
          tieneTest: panelLote.length > 0
        };

        var evaluacion = evaluarRiesgo(ctx);
        var segregado = evaluacion.riesgo === 'Critico';
        var principal = hallazgoPrincipal(hallazgos);

        return {
          // --- identidad
          ID_Lote: lote.ID_Lote,
          ID_Productor: productor.ID_Productor,
          ID_Test: panelLote.length ? panelLote[0].ID_Test : null,

          // --- origen
          Nombre: productor.Nombre,
          Finca: productor.Finca,
          lat: productor.lat,
          lon: productor.lon,
          Departamento: departamentoDe(productor.lon, productor.lat),
          Certificacion_Declarada: productor.Certificacion_Declarada,
          Proximidad_Finca_Convencional: productor.Proximidad_Finca_Convencional,
          Empresa_Exportadora: productor.Empresa_Exportadora,

          // --- verificacion (panel completo)
          Tests: panelLote,
          Kits_Ejecutados: panelLote.length,
          Kits_Totales: PANEL.length,
          Kits_Faltantes: faltantes,
          Hallazgos: hallazgos,
          Hallazgo_Principal: principal,
          Agroquimicos_Detectados: hallazgos.map(function (h) { return h.Agroquimico; }),
          Resultado_ELISA: resultadoResumen(
            productor.Certificacion_Declarada, panelLote, hallazgos, faltantes
          ),
          Timestamp: ultimoTimestamp(panelLote),
          Operador: panelLote.length ? panelLote[panelLote.length - 1].Operador : null,

          // --- lote
          Peso_Quintales: lote.Peso_Quintales,
          Tamano_Lote: tamanoDeLote(lote.Peso_Quintales),
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

  /** Mantiene los kits en el orden declarado del panel (lectura estable). */
  function ordenarPorPanel(lista) {
    var orden = PANEL.map(function (a) { return a.nombre; });
    return lista.slice().sort(function (a, b) {
      var ia = orden.indexOf(a.Agroquimico);
      var ib = orden.indexOf(b.Agroquimico);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }

  /**
   * Hallazgo que encabeza la alerta: el de mayor severidad relativa
   * (valor / umbral). Las detecciones cualitativas se tratan como 1.0,
   * es decir justo en el limite: hay presencia, sin magnitud conocida.
   */
  function hallazgoPrincipal(hallazgos) {
    if (!hallazgos.length) return null;
    return hallazgos.reduce(function (peor, h) {
      return severidadRelativa(h) > severidadRelativa(peor) ? h : peor;
    });
  }

  function severidadRelativa(t) {
    if (t.Tipo_Lectura === 'Cualitativo') return 1;
    if (!t.Umbral_ppm) return 0;
    return t.Valor_ppm / t.Umbral_ppm;
  }

  function resultadoResumen(certificacion, tests, hallazgos, faltantes) {
    // Un lote convencional no esta "sin verificar": esta fuera del alcance.
    // Marcarlo como pendiente inflaria la cola de trabajo del acopio.
    if (certificacion !== 'Organico') return 'No_Aplica';
    if (!tests.length) return 'Sin_Test';
    if (hallazgos.length) return 'Contaminado';
    if (faltantes.length) return 'Panel_Incompleto';
    return 'Conforme';
  }

  function ultimoTimestamp(tests) {
    return tests.reduce(function (max, t) {
      return !max || String(t.Timestamp) > String(max) ? t.Timestamp : max;
    }, null);
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
      return r.Kits_Ejecutados > 0;
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

    // Cobertura del panel: kits efectivamente corridos sobre los que el
    // protocolo exige. Es mas exigente que "el lote tiene algun test" y es
    // el indicador que refleja la integracion de los 4 kits.
    var kitsEsperados = organicos.length * PANEL.length;
    var kitsEjecutados = d3.sum(organicos, function (r) {
      return r.Kits_Ejecutados;
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
      lotesPanelIncompleto: organicos.filter(function (r) {
        return r.Kits_Ejecutados > 0 && r.Kits_Faltantes.length > 0;
      }).length,
      kitsEsperados: kitsEsperados,
      kitsEjecutados: kitsEjecutados,
      kitsPanel: PANEL.length,
      tasaContaminacion: tasa,
      coberturaTesteo: kitsEsperados ? (kitsEjecutados / kitsEsperados) * 100 : 0,
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
      version: '1.1.0-MVP',
      emitido_en: new Date().toISOString(),
      fuente_datos: origen,
      parametros: {
        panel_agroquimicos: PANEL.map(function (a) {
          return {
            agroquimico: a.nombre,
            clase: a.clase,
            kit: a.kit,
            lectura: a.lectura,
            umbral_ppm: a.umbral_ppm
          };
        }),
        penalizacion_usd_quintal: CONFIG.PENALIZACION_USD_POR_QUINTAL,
        referencia_penalizacion:
          'Gestion (2019-11-15): la UE castiga el cafe organico con hasta US$50/quintal por rastros de glifosato.'
      },
      resumen: kpis,
      pasaportes: registros.map(function (r) {
        return {
          id_pasaporte:
            r.ID_Lote + '::' + r.ID_Productor + '::' +
            (r.Kits_Ejecutados ? r.Kits_Ejecutados + 'KITS' : 'SIN_TEST'),
          cadena: [
            {
              etapa: '1_ORIGEN',
              entidad: r.Finca,
              productor: r.Nombre,
              id: r.ID_Productor,
              geo: { lat: r.lat, lon: r.lon, departamento: r.Departamento },
              empresa_exportadora: r.Empresa_Exportadora,
              certificacion_declarada: r.Certificacion_Declarada,
              proximidad_convencional: r.Proximidad_Finca_Convencional
            },
            {
              etapa: '2_VERIFICACION_PANEL_ELISA',
              kits_ejecutados: r.Kits_Ejecutados,
              kits_totales: r.Kits_Totales,
              kits_faltantes: r.Kits_Faltantes,
              resultado_panel: r.Resultado_ELISA,
              resultados: r.Tests.map(function (t) {
                return {
                  id: t.ID_Test,
                  agroquimico: t.Agroquimico,
                  clase: t.Clase,
                  kit: t.Kit,
                  lectura: t.Tipo_Lectura,
                  valor_ppm: t.Valor_ppm,
                  umbral_ppm: t.Umbral_ppm,
                  detectado: t.Detectado,
                  excede_umbral: t.Excede,
                  resultado_declarado: t.Resultado_Declarado,
                  resultado_calculado: t.Resultado,
                  timestamp: t.Timestamp,
                  operador: t.Operador
                };
              })
            },
            {
              etapa: '3_CONSOLIDACION_LOTE',
              id: r.ID_Lote,
              peso_quintales: r.Peso_Quintales,
              tamano: r.Tamano_Lote,
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
    PANEL: PANEL,
    load: load,
    agregarRegistro: agregarRegistro,
    limpiarRegistrosLocales: limpiarRegistrosLocales,
    leerLocales: leerLocales,
    evaluarRiesgo: evaluarRiesgo,
    calcularKPIs: calcularKPIs,
    tamanoDeLote: tamanoDeLote,
    definicionAgroquimico: function (nombre) {
      return PANEL_POR_NOMBRE.get(nombre) || null;
    }
  };
})(window);
