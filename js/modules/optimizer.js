/* ==========================================================================
   CafeTrace · modules/optimizer.js
   --------------------------------------------------------------------------
   Modelo de optimizacion de segregacion de lotes, dentro del tablero.

   El motor de reglas dice que le pasa a cada lote por separado. Esta capa
   responde la pregunta que el supervisor tiene que contestar de verdad al
   armar un embarque: de todos estos lotes, cuales van a exportacion
   organica y cuales se redirigen a mercado convencional. No es la misma
   pregunta, porque el contenedor es una unidad y el riesgo se agrega dentro
   de el: un lote aceptable por si solo puede dejar de serlo si viaja junto
   a otros tres parecidos.

   ---------------------------------------------------------------------
   1. De donde sale la probabilidad de cada lote
   ---------------------------------------------------------------------
   Hay tres situaciones y cada una se resuelve distinto.

     Panel con hallazgo    El kit ya detecto residuo sobre criterio. La
                           probabilidad es uno. No es una estimacion, es una
                           medicion, y ninguna prediccion la mejora.

     Panel cerrado limpio  Los cuatro kits corrieron y ninguno excedio.
                           Queda la sensibilidad residual del inmunoensayo
                           cerca del umbral, que es un supuesto de dominio.

     Panel abierto         Faltan kits por correr. La probabilidad es la
                           frecuencia con que, en la base historica, al
                           menos uno de esos kits faltantes dio hallazgo,
                           condicionada al grupo de proximidad al lindero
                           convencional.

   El tercer caso es donde la prediccion aporta valor, y es tambien el que
   justifica cerrar el panel: mientras falten kits, el lote arrastra una
   probabilidad que consume presupuesto de riesgo del contenedor.

   Las frecuencias se calculan con scripts/calcular_priors.py sobre la base
   historica y se leen de data/priors_riesgo.json. Son frecuencias conjuntas
   observadas y no producto de marginales: los cuatro kits comparten causa,
   de modo que suponer independencia sobreestima el riesgo hasta en un 23
   por ciento en el grupo de proximidad alta.

   ---------------------------------------------------------------------
   2. El problema de decision
   ---------------------------------------------------------------------
   Variable de decision. Una binaria por lote, uno si va a exportacion
   organica y cero si se segrega.

   Objetivo. Maximizar

       suma de  x_i por w_i por ((V_org menos V_conv) menos lambda por p_i)

   El ingreso del lote segregado no es cero, se vende igual a menor precio,
   asi que ese termino es constante y sale del objetivo. Lo que queda en el
   margen es la prima organica menos el costo esperado de exportar un lote
   que podria estar contaminado.

   Restriccion de riesgo del contenedor. La probabilidad media de lo
   exportado, ponderada por volumen, no puede superar la tolerancia alfa:

       suma de  x_i por w_i por (p_i menos alfa)  menor o igual a cero

   Escrita asi es lineal y no hay que linealizar ningun cociente, que es el
   error habitual al implementar esta formulacion.

   Restriccion de cuarentena espacial. Si una finca resulta foco, sus fincas
   vecinas dentro del radio de amortiguamiento quedan excluidas aunque su
   propia probabilidad sea baja. La deriva no respeta linderos.

   ---------------------------------------------------------------------
   3. Como se resuelve, y por que no hace falta un solver
   ---------------------------------------------------------------------
   El notebook resuelve este mismo modelo con un solver de programacion
   entera mixta. Aqui no se puede: el tablero tiene que abrir con doble clic
   y funcionar sin conexion en el centro de acopio.

   No hace falta. Con una sola restriccion el problema es una mochila
   binaria, y se resuelve de forma exacta. El unico detalle es que los
   coeficientes de la restriccion pueden ser negativos: un lote con
   probabilidad por debajo de la tolerancia no consume presupuesto de
   riesgo, lo aporta. Se normaliza con el cambio de variable clasico

       y_i = 1 menos x_i   para los lotes de coeficiente negativo

   que deja todos los pesos positivos y convierte el problema en una mochila
   estandar, resoluble por programacion dinamica. Los pesos se discretizan
   redondeando hacia arriba y la capacidad hacia abajo, de modo que la
   solucion obtenida siempre es factible en el problema original.

   scripts/verificar_optimizador.py comprueba que este modulo y el solver
   del notebook devuelven el mismo valor objetivo sobre instancias
   aleatorias.
   ========================================================================== */
(function (global) {
  'use strict';

  var CT = (global.CT = global.CT || {});

  /* ---------------------------------------------------------------------
     PARAMETROS
     Los mismos que usa el notebook. Cambiarlos aqui cambia el plan, no las
     alertas: el motor de reglas es independiente de esta capa.
     --------------------------------------------------------------------- */
  var CONFIG = {
    // Precios por quintal en cada canal comercial.
    PRECIO_ORGANICO: 210,
    PRECIO_CONVENCIONAL: 160,

    // Costo por unidad de probabilidad de contaminacion de un lote que
    // embarca. Se descompone en penalizacion directa de 50, arrastre sobre
    // el resto del contenedor de 130 y riesgo de certificacion de 80.
    // El punto de indiferencia queda en 50 sobre 260, es decir 0.192.
    LAMBDA_RIESGO: 260,

    // Tolerancia de riesgo del contenedor. Es una clausula comercial, no un
    // parametro tecnico, y por eso el tablero deja cambiarla.
    ALFA_CONTENEDOR: 0.05,

    // Probabilidad a partir de la cual una finca se declara foco, y radio
    // de amortiguamiento en metros.
    P_CUARENTENA: 0.80,
    RADIO_CUARENTENA_M: 800,

    // Techo de pasos de la programacion dinamica. Acota el costo de la
    // discretizacion sin volver perceptible el error.
    PASOS_MOCHILA: 20000
  };

  /* ---------------------------------------------------------------------
     PRIORS
     Semilla embebida para que el tablero tambien funcione abierto con doble
     clic. Si hay servidor, se refresca desde data/priors_riesgo.json.
     Mantener sincronizado con scripts/calcular_priors.py.
     --------------------------------------------------------------------- */
  var PRIORS = {
    "sensibilidad_residual": 0.02,
    "panel": [
      "Glifosato",
      "Clorpirifos",
      "Cipermetrina",
      "Carbendazim"
    ],
    "probabilidad_algun_hallazgo": {
      "Alta": {
        "Glifosato": 0.11602,
        "Clorpirifos": 0.13715,
        "Cipermetrina": 0.14138,
        "Carbendazim": 0.01315,
        "Glifosato|Clorpirifos": 0.19868,
        "Glifosato|Cipermetrina": 0.21841,
        "Glifosato|Carbendazim": 0.12071,
        "Clorpirifos|Cipermetrina": 0.24096,
        "Clorpirifos|Carbendazim": 0.14937,
        "Cipermetrina|Carbendazim": 0.15171,
        "Glifosato|Clorpirifos|Cipermetrina": 0.28276,
        "Glifosato|Clorpirifos|Carbendazim": 0.20338,
        "Glifosato|Cipermetrina|Carbendazim": 0.22264,
        "Clorpirifos|Cipermetrina|Carbendazim": 0.25082,
        "Glifosato|Clorpirifos|Cipermetrina|Carbendazim": 0.28699
      },
      "Baja": {
        "Glifosato": 0.04925,
        "Clorpirifos": 0.10237,
        "Cipermetrina": 0.11299,
        "Carbendazim": 0.01111,
        "Glifosato|Clorpirifos": 0.14148,
        "Glifosato|Cipermetrina": 0.15307,
        "Glifosato|Carbendazim": 0.05843,
        "Clorpirifos|Cipermetrina": 0.19121,
        "Clorpirifos|Carbendazim": 0.11202,
        "Cipermetrina|Carbendazim": 0.12313,
        "Glifosato|Clorpirifos|Cipermetrina": 0.22405,
        "Glifosato|Clorpirifos|Carbendazim": 0.14969,
        "Glifosato|Cipermetrina|Carbendazim": 0.16127,
        "Clorpirifos|Cipermetrina|Carbendazim": 0.1999,
        "Glifosato|Clorpirifos|Cipermetrina|Carbendazim": 0.23129
      },
      "Global": {
        "Glifosato": 0.0831,
        "Clorpirifos": 0.12,
        "Cipermetrina": 0.12738,
        "Carbendazim": 0.01214,
        "Glifosato|Clorpirifos": 0.17048,
        "Glifosato|Cipermetrina": 0.18619,
        "Glifosato|Carbendazim": 0.09,
        "Clorpirifos|Cipermetrina": 0.21643,
        "Clorpirifos|Carbendazim": 0.13095,
        "Cipermetrina|Carbendazim": 0.13762,
        "Glifosato|Clorpirifos|Cipermetrina": 0.25381,
        "Glifosato|Clorpirifos|Carbendazim": 0.1769,
        "Glifosato|Cipermetrina|Carbendazim": 0.19238,
        "Clorpirifos|Cipermetrina|Carbendazim": 0.22571,
        "Glifosato|Clorpirifos|Cipermetrina|Carbendazim": 0.25952
      }
    }
  };

  function cargarPriors() {
    if (global.location.protocol === 'file:' || typeof fetch !== 'function') {
      return Promise.resolve(PRIORS);
    }
    return fetch('data/priors_riesgo.json', { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (json) {
        if (json && json.probabilidad_algun_hallazgo) PRIORS = json;
        return PRIORS;
      })
      .catch(function (err) {
        console.warn(
          '[CafeTrace] no se pudo leer data/priors_riesgo.json, se usa la ' +
            'semilla embebida. Motivo: ' + err.message
        );
        return PRIORS;
      });
  }

  /* ---------------------------------------------------------------------
     PROBABILIDAD POR LOTE
     --------------------------------------------------------------------- */
  function grupoProximidad(registro) {
    var prox = registro.Proximidad_Finca_Convencional;
    if (prox === 'Alta' || prox === 'Baja') return prox;
    return 'Global';
  }

  /** Clave del prior: kits faltantes en el orden declarado del panel. */
  function claveFaltantes(faltantes) {
    var orden = PRIORS.panel || [];
    return faltantes
      .slice()
      .sort(function (a, b) {
        return orden.indexOf(a) - orden.indexOf(b);
      })
      .join('|');
  }

  /**
   * Probabilidad de que el lote este contaminado.
   * @returns {{p:number, origen:string, detalle:string}}
   */
  function probabilidadDe(registro) {
    if (registro.Certificacion_Declarada !== 'Organico') {
      return {
        p: null,
        origen: 'fuera_de_alcance',
        detalle: 'Lote convencional, fuera del alcance de verificacion organica.'
      };
    }

    if (registro.Hallazgos && registro.Hallazgos.length) {
      return {
        p: 1,
        origen: 'medido',
        detalle:
          'Residuo confirmado por el panel: ' +
          registro.Agroquimicos_Detectados.join(', ') + '.'
      };
    }

    var faltantes = registro.Kits_Faltantes || [];

    if (!faltantes.length) {
      return {
        p: PRIORS.sensibilidad_residual,
        origen: 'panel_cerrado',
        detalle:
          'Panel completo y conforme. Queda la sensibilidad residual del kit ' +
          'cerca del umbral.'
      };
    }

    var grupo = grupoProximidad(registro);
    var tabla = PRIORS.probabilidad_algun_hallazgo[grupo] ||
                PRIORS.probabilidad_algun_hallazgo.Global;
    var clave = claveFaltantes(faltantes);
    var p = tabla[clave];

    if (typeof p !== 'number') {
      // Combinacion no tabulada: se usa el panel completo como cota superior.
      p = tabla[(PRIORS.panel || []).join('|')];
    }

    return {
      p: p,
      origen: 'prior',
      detalle:
        'Panel abierto. Frecuencia historica de hallazgo en los kits que ' +
        'faltan (' + faltantes.join(', ') + ') para proximidad ' +
        grupo.toLowerCase() + '.'
    };
  }

  /* ---------------------------------------------------------------------
     GEOMETRIA
     --------------------------------------------------------------------- */
  /** Distancia sobre la esfera, en metros. */
  function distanciaM(a, b) {
    var R = 6371000;
    var rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad;
    var dLon = (b.lon - a.lon) * rad;
    var h =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /**
   * Fincas en cuarentena: los focos y sus colindantes dentro del radio.
   *
   * Distingue dos situaciones que no son la misma:
   *
   *   Finca foco       La contaminacion esta confirmada ahi. Se bloquean
   *                    todos sus lotes, tengan el panel cerrado o no. Un
   *                    panel limpio a metros de una fuente confirmada pide
   *                    un retesteo, no una liberacion.
   *
   *   Finca colindante No hay contaminacion confirmada, solo cercania a una
   *                    fuente. El bloqueo alcanza a los lotes cuyo panel
   *                    sigue abierto, que son los que de verdad no se
   *                    sabe. Un lote con los cuatro kits corridos y
   *                    conformes ya fue medido, y sustituir esa medicion
   *                    por un prior espacial es invertir la jerarquia de la
   *                    evidencia: seria rechazar el cafe de un productor
   *                    que dio limpio cuatro veces por lo que ocurrio en la
   *                    parcela del vecino.
   *
   * @returns {{focos:Set, cuarentena:Set, vecinas:Map, colindantes:Set}}
   */
  function calcularCuarentena(lotes, config) {
    var porFinca = new Map();
    lotes.forEach(function (l) {
      var previo = porFinca.get(l.ID_Productor);
      if (!previo || l.p > previo.p) {
        porFinca.set(l.ID_Productor, { p: l.p, lat: l.lat, lon: l.lon });
      }
    });

    var ids = Array.from(porFinca.keys());
    var focos = new Set();
    ids.forEach(function (id) {
      if (porFinca.get(id).p > config.P_CUARENTENA) focos.add(id);
    });

    var vecinas = new Map();
    var colindantes = new Set();

    focos.forEach(function (foco) {
      var lista = [];
      ids.forEach(function (otro) {
        if (otro === foco || focos.has(otro)) return;
        var d = distanciaM(porFinca.get(foco), porFinca.get(otro));
        if (d < config.RADIO_CUARENTENA_M) {
          lista.push({ finca: otro, metros: Math.round(d) });
          colindantes.add(otro);
        }
      });
      if (lista.length) vecinas.set(foco, lista);
    });

    var cuarentena = new Set(focos);
    colindantes.forEach(function (f) { cuarentena.add(f); });

    return {
      focos: focos,
      colindantes: colindantes,
      cuarentena: cuarentena,
      vecinas: vecinas
    };
  }

  /* ---------------------------------------------------------------------
     MOCHILA BINARIA EXACTA
     --------------------------------------------------------------------- */
  /**
   * Maximiza la suma de valores sujeta a que la suma de pesos no supere la
   * capacidad. Pesos y capacidad ya vienen en enteros.
   * @returns {Array<number>} indices de los items elegidos
   */
  function mochila(items, capacidad) {
    var n = items.length;
    if (!n || capacidad <= 0) return [];

    // mejor[c] es el mejor valor alcanzable con capacidad c.
    var mejor = new Float64Array(capacidad + 1);
    // tomado es una matriz de bits: una fila por item.
    var tomado = new Uint8Array(n * (capacidad + 1));

    for (var i = 0; i < n; i++) {
      var peso = items[i].peso;
      var valor = items[i].valor;
      var base = i * (capacidad + 1);
      // Recorrido descendente: cada item se puede usar una sola vez.
      for (var c = capacidad; c >= peso; c--) {
        var candidato = mejor[c - peso] + valor;
        if (candidato > mejor[c] + 1e-12) {
          mejor[c] = candidato;
          tomado[base + c] = 1;
        }
      }
    }

    // Reconstruccion hacia atras.
    var elegidos = [];
    var restante = capacidad;
    for (var j = n - 1; j >= 0; j--) {
      if (tomado[j * (capacidad + 1) + restante]) {
        elegidos.push(items[j].indice);
        restante -= items[j].peso;
      }
    }
    return elegidos;
  }

  /* ---------------------------------------------------------------------
     RESOLUCION
     --------------------------------------------------------------------- */
  /**
   * Construye el plan de segregacion.
   * @param {Array} registros  Registros unidos que emite el DataLoader.
   * @param {Object} opciones  Sobrescribe cualquier clave de CONFIG.
   */
  function resolver(registros, opciones) {
    var config = Object.assign({}, CONFIG, opciones || {});
    var delta = config.PRECIO_ORGANICO - config.PRECIO_CONVENCIONAL;
    var indiferencia = delta / config.LAMBDA_RIESGO;

    // Punto de inyeccion. Por defecto la probabilidad sale de los priors,
    // pero se puede sustituir por el puntaje calibrado de un modelo cuando
    // el lote tenga las variables de campo que ese modelo necesita, y lo usa
    // tambien el verificador contra el solver del notebook.
    var calcularP = config.probabilidad || probabilidadDe;

    // --- Probabilidad y separacion del alcance organico
    function mapear(r) {
      var prob = calcularP(r);
      return {
        registro: r,
        ID_Lote: r.ID_Lote,
        ID_Productor: r.ID_Productor,
        Finca: r.Finca,
        Empresa_Exportadora: r.Empresa_Exportadora,
        Destino: r.Destino,
        quintales: r.Peso_Quintales,
        lat: r.lat,
        lon: r.lon,
        p: prob.p,
        origen: prob.origen,
        detalle: prob.detalle
      };
    }

    var todos = registros.map(mapear);

    var organicos = todos.filter(function (l) { return l.p !== null; });
    var fueraDeAlcance = todos.filter(function (l) { return l.p === null; });

    // --- Cuarentena espacial
    //
    // La geometria se calcula sobre la cartera completa, no sobre el
    // subconjunto que el usuario dejo visible con los filtros del mapa. La
    // colindancia con una finca foco es un hecho del territorio: filtrar la
    // vista por exportadora o por destino no aleja la parcela contaminada
    // del vecino. Si se calculara sobre lo visible, ocultar la finca foco
    // levantaria el bloqueo de sus colindantes, que es exactamente el modo
    // en que un filtro de lectura se convierte en una falla de seguridad.
    var universo = config.universo ? config.universo.map(mapear) : todos;
    var organicosUniverso = universo.filter(function (l) { return l.p !== null; });
    var cuarentena = calcularCuarentena(organicosUniverso, config);
    organicos.forEach(function (l) {
      l.esFoco = cuarentena.focos.has(l.ID_Productor);
      l.panelCerrado = l.origen === 'panel_cerrado' || l.origen === 'medido';

      // El panel cerrado exime del bloqueo por colindancia, no del bloqueo
      // por ser finca foco.
      l.colinda = cuarentena.colindantes.has(l.ID_Productor);
      l.enCuarentena = l.esFoco || (l.colinda && !l.panelCerrado);
      l.exentoPorPanel = l.colinda && l.panelCerrado;
    });

    var candidatos = organicos.filter(function (l) { return !l.enCuarentena; });

    // --- Coeficientes del modelo
    candidatos.forEach(function (l) {
      l.valor = l.quintales * (delta - config.LAMBDA_RIESGO * l.p);
      l.costoRiesgo = l.quintales * (l.p - config.ALFA_CONTENEDOR);
    });

    // --- Cambio de variable sobre los coeficientes negativos
    var aportan = candidatos.filter(function (l) { return l.costoRiesgo < 0; });
    var consumen = candidatos.filter(function (l) { return l.costoRiesgo >= 0; });

    var capacidadReal = aportan.reduce(function (s, l) {
      return s + (-l.costoRiesgo);
    }, 0);

    // Los lotes que aportan presupuesto entran por defecto; el problema
    // transformado decide a cuales conviene sacar.
    var seleccion = new Set(aportan.map(function (l) { return l.ID_Lote; }));

    if (capacidadReal > 0) {
      var items = [];

      consumen.forEach(function (l) {
        // Tomarlo consume presupuesto y aporta su valor.
        if (l.valor > 0) {
          items.push({ indice: l.ID_Lote, valorReal: l.valor, pesoReal: l.costoRiesgo, sacar: false });
        }
      });

      aportan.forEach(function (l) {
        // Sacarlo libera su valor negativo y consume el presupuesto que
        // aportaba. Solo tiene sentido si su valor es negativo.
        if (l.valor < 0) {
          items.push({ indice: l.ID_Lote, valorReal: -l.valor, pesoReal: -l.costoRiesgo, sacar: true });
        }
      });

      if (items.length) {
        // Discretizacion. Pesos hacia arriba y capacidad hacia abajo, de modo
        // que la solucion siempre sea factible en el problema original.
        var escala = config.PASOS_MOCHILA / capacidadReal;
        var capacidadEntera = Math.floor(capacidadReal * escala);

        var itemsEnteros = items
          .map(function (it) {
            return {
              indice: it.indice,
              valor: it.valorReal,
              peso: Math.ceil(it.pesoReal * escala),
              sacar: it.sacar
            };
          })
          .filter(function (it) { return it.peso <= capacidadEntera; });

        var porLote = new Map();
        items.forEach(function (it) { porLote.set(it.indice, it); });

        mochila(itemsEnteros, capacidadEntera).forEach(function (idLote) {
          if (porLote.get(idLote).sacar) seleccion.delete(idLote);
          else seleccion.add(idLote);
        });
      }
    }

    // --- Armado del plan
    function motivoDe(l) {
      if (l.p === null) {
        return 'Fuera del alcance organico, se comercializa por canal convencional.';
      }
      if (seleccion.has(l.ID_Lote)) {
        if (l.exentoPorPanel) {
          return 'Colinda con una finca foco, pero su panel esta cerrado y ' +
            'conforme: la medicion directa manda sobre la cercania.';
        }
        return 'Cumple la tolerancia de riesgo y no esta en zona de cuarentena.';
      }
      if (l.esFoco) {
        return 'Finca foco de contaminacion: riesgo confirmado sobre el umbral de cuarentena.';
      }
      if (l.enCuarentena) {
        return 'Cuarentena espacial: colinda con una finca foco dentro de ' +
          config.RADIO_CUARENTENA_M + ' m y su panel sigue abierto.';
      }
      if (l.origen === 'medido') {
        return 'Residuo confirmado por el panel ELISA.';
      }
      if (l.p >= indiferencia) {
        return 'El riesgo esperado supera la prima organica del lote ' +
          '(indiferencia en ' + (indiferencia * 100).toFixed(1) + ' por ciento).';
      }
      return 'Excluido para no romper la tolerancia agregada del contenedor.';
    }

    var plan = organicos.concat(fueraDeAlcance).map(function (l) {
      var exporta = seleccion.has(l.ID_Lote);
      return {
        ID_Lote: l.ID_Lote,
        ID_Productor: l.ID_Productor,
        Finca: l.Finca,
        Empresa_Exportadora: l.Empresa_Exportadora,
        Destino: l.Destino,
        quintales: l.quintales,
        p: l.p,
        origen: l.origen,
        detalleProbabilidad: l.detalle,
        enCuarentena: !!l.enCuarentena,
        esFoco: !!l.esFoco,
        colinda: !!l.colinda,
        exentoPorPanel: !!l.exentoPorPanel,
        exporta: exporta,
        decision: exporta ? 'EXPORTACION_ORGANICA' : 'SEGREGAR_CONVENCIONAL',
        motivo: motivoDe(l),
        valorAsignado:
          l.quintales * (exporta ? config.PRECIO_ORGANICO : config.PRECIO_CONVENCIONAL),
        registro: l.registro
      };
    });

    plan.sort(function (a, b) {
      // Primero lo que exige accion, y dentro de eso lo mas riesgoso.
      if (a.exporta !== b.exporta) return a.exporta ? 1 : -1;
      return (b.p === null ? -1 : b.p) - (a.p === null ? -1 : a.p);
    });

    return Object.assign({ plan: plan, config: config }, resumir(plan, config, cuarentena));
  }

  /** Agregados del plan, incluida la verificacion de la restriccion. */
  function resumir(plan, config, cuarentena) {
    var exportados = plan.filter(function (l) { return l.exporta; });
    var qqExportados = exportados.reduce(function (s, l) { return s + l.quintales; }, 0);
    var qqTotales = plan.reduce(function (s, l) { return s + l.quintales; }, 0);

    var riesgoPonderado = qqExportados
      ? exportados.reduce(function (s, l) { return s + l.p * l.quintales; }, 0) / qqExportados
      : 0;

    var valorPlan = plan.reduce(function (s, l) { return s + l.valorAsignado; }, 0);
    var valorTodoConvencional = qqTotales * config.PRECIO_CONVENCIONAL;

    // Costo esperado de la contaminacion que igual viaja en el contenedor.
    var costoEsperado = exportados.reduce(function (s, l) {
      return s + l.p * l.quintales * config.LAMBDA_RIESGO;
    }, 0);

    // Contrafactual: exportarlo todo sin filtrar, con su costo esperado.
    var enAlcance = plan.filter(function (l) { return l.p !== null; });
    var qqAlcance = enAlcance.reduce(function (s, l) { return s + l.quintales; }, 0);
    var valorTodoOrganico =
      qqAlcance * config.PRECIO_ORGANICO +
      (qqTotales - qqAlcance) * config.PRECIO_CONVENCIONAL -
      enAlcance.reduce(function (s, l) {
        return s + l.p * l.quintales * config.LAMBDA_RIESGO;
      }, 0);

    return {
      lotesExportados: exportados.length,
      lotesSegregados: plan.length - exportados.length,
      lotesTotales: plan.length,
      quintalesExportados: qqExportados,
      quintalesTotales: qqTotales,
      riesgoPonderado: riesgoPonderado,
      cumpleTolerancia: riesgoPonderado <= config.ALFA_CONTENEDOR + 1e-9,
      valorPlan: valorPlan,
      valorNetoPlan: valorPlan - costoEsperado,
      valorTodoConvencional: valorTodoConvencional,
      valorTodoOrganico: valorTodoOrganico,
      gananciaSobreConvencional: valorPlan - costoEsperado - valorTodoConvencional,
      costoEsperadoContaminacion: costoEsperado,
      fincasFoco: Array.from(cuarentena.focos),
      fincasColindantes: Array.from(cuarentena.colindantes),
      fincasCuarentena: Array.from(cuarentena.cuarentena),
      lotesExentosPorPanel: plan.filter(function (l) { return l.exentoPorPanel; }).length,
      vecindades: cuarentena.vecinas
    };
  }

  CT.Optimizer = {
    CONFIG: CONFIG,
    cargarPriors: cargarPriors,
    probabilidadDe: probabilidadDe,
    resolver: resolver,
    distanciaM: distanciaM,
    priors: function () { return PRIORS; }
  };
})(window);
