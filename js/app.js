/* ==========================================================================
   CafeTrace · app.js
   --------------------------------------------------------------------------
   Controlador principal del dashboard.

   Flujo:
     DataLoader.load()  ->  registros + KPIs + ledger
                        ->  MapFilters (barra sobre el mapa)
                        ->  subconjunto visible
                        ->  KPIs en cabecera
                        ->  MapRisk (columna izquierda)
                        ->  AlertsFeed (columna derecha)
                        ->  TreeTrace (seccion inferior, bajo demanda)

   El filtro es transversal por diseno: KPIs, mapa y alertas leen SIEMPRE el
   mismo subconjunto. Filtrar "Perhusa + Alemania" y que los KPIs siguieran
   mostrando el total de la cooperativa daria una lectura falsa de la
   cartera que se esta revisando.

   Tambien gestiona el formulario de alta de registros, que persiste en
   localStorage y vuelve a ejecutar todo el pipeline (join + reglas + KPIs)
   sin recargar la pagina.
   ========================================================================== */
(function (global) {
  'use strict';

  var CT = (global.CT = global.CT || {});

  var estado = {
    registros: [],   // dataset completo
    visibles: [],    // subconjunto que pasa los filtros del mapa
    kpis: null,
    ledger: null,
    seleccion: null,
    plan: null       // salida del optimizador sobre el subconjunto visible
  };

  var mapa, arbol, feed, filtros;

  var fmtEntero = d3.format(',.0f');
  var fmtDecimal = d3.format('.1f');

  /* =====================================================================
     1. KPIs
     ===================================================================== */
  function renderKPIs(k, filtrado) {
    setTexto('#kpi-quintales', fmtEntero(k.quintalesTotales));
    setTexto(
      '#kpi-quintales-sub',
      fmtEntero(k.quintalesOrganicos) + ' qq organicos · ' + k.lotesTotales + ' lotes'
    );

    setTexto('#kpi-tasa', fmtDecimal(k.tasaContaminacion) + '%');
    setTexto(
      '#kpi-tasa-sub',
      k.lotesCriticos + ' de ' + k.lotesOrganicosTesteados + ' lotes organicos testeados'
    );

    setTexto('#kpi-ahorro', 'US$ ' + fmtEntero(k.ahorroUSD));
    setTexto(
      '#kpi-ahorro-sub',
      fmtEntero(k.quintalesSegregados) + ' qq segregados × US$' +
        k.penalizacionPorQuintal + '/qq'
    );

    setTexto('#kpi-cobertura', fmtDecimal(k.coberturaTesteo) + '%');
    setTexto(
      '#kpi-cobertura-sub',
      k.kitsEjecutados + ' de ' + k.kitsEsperados + ' kits del panel (' +
        k.kitsPanel + ' por lote organico)'
    );

    // Semaforo del KPI de tasa: la cifra cambia de tono segun severidad.
    var tarjetaTasa = document.querySelector('#kpi-card-tasa');
    if (tarjetaTasa) {
      tarjetaTasa.classList.toggle('is-danger', k.tasaContaminacion > 0);
    }
    var tarjetaCob = document.querySelector('#kpi-card-cobertura');
    if (tarjetaCob) {
      tarjetaCob.classList.toggle('is-warn', k.coberturaTesteo < 100);
    }

    // Marca visible de que los indicadores responden a una seleccion parcial.
    var kpis = document.querySelector('.ct-kpis');
    if (kpis) kpis.classList.toggle('is-filtrado', !!filtrado);
  }

  function setTexto(sel, texto) {
    var el = document.querySelector(sel);
    if (el) el.textContent = texto;
  }

  /* =====================================================================
     2. Vista: KPIs + mapa + alertas sobre el subconjunto filtrado
     ===================================================================== */
  function aplicarVista(visibles, filtrosActivos) {
    estado.visibles = visibles;
    estado.kpis = CT.DataLoader.calcularKPIs(visibles);

    renderKPIs(estado.kpis, filtrosActivos > 0);
    mapa.actualizar(visibles);

    var alertas = feed.actualizar(visibles);
    setTexto('#alertas-contador', alertas.length + ' alerta(s)');

    renderPlan();

    // El pasaporte abierto se mantiene: es una lectura en curso, no parte
    // de la seleccion. Solo se refresca con los datos vigentes.
    if (estado.seleccion) {
      mapa.seleccionar(estado.seleccion.ID_Lote);
    }
  }

  /* =====================================================================
     3. Seleccion de lote (mapa <-> alertas <-> arbol)
     ===================================================================== */
  function seleccionarLote(registro) {
    estado.seleccion = registro;
    mapa.seleccionar(registro.ID_Lote);
    arbol.mostrar(registro);

    setTexto(
      '#trace-subtitulo',
      registro.ID_Lote + ' · ' + registro.Finca + ' · ' + registro.Empresa_Exportadora
    );

    var badge = document.querySelector('#trace-riesgo');
    if (badge) {
      badge.textContent = registro.Riesgo;
      badge.style.background = CT.MapRisk.colorDe(registro.Riesgo);
      badge.hidden = false;
    }

    var seccion = document.querySelector('#seccion-trazabilidad');
    if (seccion) seccion.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* =====================================================================
     4. Leyenda del mapa
     ===================================================================== */
  function renderLeyenda() {
    var cont = d3.select('#mapa-leyenda');
    cont.selectAll('*').remove();

    [
      ['Bajo', 'Panel cerrado y conforme'],
      ['Medio', 'Deriva potencial'],
      ['Alto', 'Panel abierto o sin ejecutar'],
      ['Critico', 'Residuo sobre criterio'],
      ['No aplica', 'Convencional']
    ].forEach(function (par) {
      var item = cont.append('span').attr('class', 'ct-leyenda-item');
      item
        .append('span')
        .attr('class', 'ct-leyenda-punto')
        .style('background', CT.MapRisk.colorDe(par[0]));
      item.append('span').text(par[1]);
    });

    cont
      .append('span')
      .attr('class', 'ct-leyenda-item ct-leyenda-nota')
      .text(
        'Proyeccion Mercator · area del marcador ∝ quintales · ' +
        'linea punteada = vector de deriva a la finca convencional mas cercana'
      );
  }

  /* =====================================================================
     5. Plan de segregacion
     ---------------------------------------------------------------------
     El motor de reglas dice que le pasa a cada lote. El optimizador dice
     que hacer con el conjunto, que es la decision que el supervisor toma
     de verdad al armar un embarque. Se resuelve sobre el mismo subconjunto
     filtrado que alimenta el mapa y las alertas: si el usuario esta viendo
     la cartera de una exportadora, el plan es el de esa cartera y la
     tolerancia se aplica a ese contenedor.
     ===================================================================== */
  function toleranciaElegida() {
    var sel = document.querySelector('#plan-alfa');
    return sel ? parseFloat(sel.value) : CT.Optimizer.CONFIG.ALFA_CONTENEDOR;
  }

  function renderPlan() {
    var alfa = toleranciaElegida();
    // El plan se optimiza sobre lo visible, pero la cuarentena se calcula
    // sobre la cartera completa: un filtro de lectura no puede levantar un
    // bloqueo espacial escondiendo la finca foco.
    estado.plan = CT.Optimizer.resolver(estado.visibles, {
      ALFA_CONTENEDOR: alfa,
      universo: estado.registros
    });

    renderPlanAlcance(alfa);
    renderPlanKPIs(estado.plan, alfa);
    renderPlanLista(estado.plan);
  }

  function renderPlanAlcance(alfa) {
    var r = estado.plan;
    var hayFiltros = filtros.activos() > 0;

    setTexto(
      '#plan-alcance',
      r.lotesTotales + ' lote(s)' +
        (hayFiltros ? ' de la seleccion filtrada' : ' de la cartera completa')
    );

    var veredicto = document.querySelector('#plan-veredicto');
    if (veredicto) {
      if (!r.lotesExportados) {
        veredicto.textContent = 'SIN EMBARQUE VIABLE';
        veredicto.style.background = CT.MapRisk.colorDe('Critico');
      } else if (r.cumpleTolerancia) {
        veredicto.textContent = 'PLAN VIABLE';
        veredicto.style.background = CT.MapRisk.colorDe('Bajo');
      } else {
        veredicto.textContent = 'TOLERANCIA EXCEDIDA';
        veredicto.style.background = CT.MapRisk.colorDe('Alto');
      }
      veredicto.hidden = false;
    }

    var nota = document.querySelector('#plan-nota');
    if (!nota) return;

    if (!r.lotesExportados && r.lotesTotales) {
      nota.className = 'ct-plan-nota is-alerta';
      nota.innerHTML =
        'Ningun subconjunto de lotes baja del <strong>' +
        fmtPct(alfa) + '</strong> de riesgo medio ponderado. ' +
        'Con la calidad de verificacion actual esa tolerancia no es ' +
        'alcanzable: hay que cerrar paneles o renegociar la clausula.';
    } else {
      var indiferencia = CT.Optimizer.CONFIG.PRECIO_ORGANICO -
        CT.Optimizer.CONFIG.PRECIO_CONVENCIONAL;
      nota.className = 'ct-plan-nota';
      nota.innerHTML =
        'Se maximiza el valor sujeto a que el riesgo medio ponderado por ' +
        'volumen no supere la tolerancia. Un lote deja de compensar por si ' +
        'solo sobre <strong>' +
        fmtPct(indiferencia / CT.Optimizer.CONFIG.LAMBDA_RIESGO) +
        '</strong> de probabilidad.';
    }
  }

  function renderPlanKPIs(r, alfa) {
    var cont = d3.select('#plan-kpis');
    cont.selectAll('*').remove();

    var tarjetas = [
      {
        titulo: 'A exportacion organica',
        valor: fmtEntero(r.quintalesExportados) + ' qq',
        sub: r.lotesExportados + ' de ' + r.lotesTotales + ' lotes',
        clase: r.lotesExportados ? 'is-ok' : 'is-alerta'
      },
      {
        titulo: 'Segregado a convencional',
        valor: fmtEntero(r.quintalesTotales - r.quintalesExportados) + ' qq',
        sub: r.lotesSegregados + ' lote(s) redirigido(s)',
        clase: ''
      },
      {
        titulo: 'Riesgo del contenedor',
        valor: r.lotesExportados ? fmtPct(r.riesgoPonderado) : 'sin embarque',
        sub: r.lotesExportados
          ? 'tolerancia ' + fmtPct(alfa) +
            (r.cumpleTolerancia ? ' · dentro' : ' · excedida')
          : 'ningun lote alcanza la tolerancia de ' + fmtPct(alfa),
        clase: !r.lotesExportados ? 'is-alerta' : r.cumpleTolerancia ? 'is-ok' : 'is-alerta'
      },
      {
        titulo: 'Valor sobre convencional',
        valor: 'US$ ' + fmtEntero(r.gananciaSobreConvencional),
        sub: 'neto del costo esperado de contaminacion',
        clase: r.gananciaSobreConvencional > 0 ? 'is-ok' : 'is-warn'
      },
      {
        titulo: 'Fincas en cuarentena',
        valor: String(r.fincasCuarentena.length),
        sub: r.fincasFoco.length + ' foco(s), ' + r.fincasColindantes.length +
          ' colindante(s)' +
          (r.lotesExentosPorPanel
            ? ' · ' + r.lotesExentosPorPanel + ' lote(s) exento(s) por panel cerrado'
            : ''),
        clase: r.fincasCuarentena.length ? 'is-warn' : ''
      }
    ];

    var celda = cont
      .selectAll('article')
      .data(tarjetas)
      .enter()
      .append('article')
      .attr('class', function (t) { return 'ct-plan-kpi ' + t.clase; });

    celda.append('h4').text(function (t) { return t.titulo; });
    celda.append('p').text(function (t) { return t.valor; });
    celda.append('span').text(function (t) { return t.sub; });
  }

  var ETIQUETA_ORIGEN = {
    medido: 'medido',
    panel_cerrado: 'panel cerrado',
    prior: 'estimado',
    fuera_de_alcance: 'no aplica'
  };

  function renderPlanLista(r) {
    var lista = d3.select('#plan-lista');
    lista.selectAll('*').remove();

    if (!r.plan.length) {
      lista
        .append('p')
        .attr('class', 'ct-plan-vacio')
        .text('Ningun lote coincide con los filtros del mapa.');
      return;
    }

    var tarjetas = lista
      .selectAll('button')
      .data(r.plan, function (l) { return l.ID_Lote; })
      .enter()
      .append('button')
      .attr('type', 'button')
      .attr('class', function (l) {
        if (l.p === null) return 'ct-plan-card is-fuera';
        if (l.exporta) return 'ct-plan-card is-exporta';
        return 'ct-plan-card ' + (l.enCuarentena ? 'is-cuarentena' : 'is-segrega');
      })
      .attr('title', function (l) { return l.detalleProbabilidad; })
      .on('click', function (evento, l) { seleccionarLote(l.registro); });

    var cab = tarjetas.append('div').attr('class', 'ct-plan-card-head');
    cab.append('span').attr('class', 'ct-plan-lote').text(function (l) {
      return l.ID_Lote + ' · ' + fmtEntero(l.quintales) + ' qq';
    });
    cab.append('span').attr('class', 'ct-plan-decision').text(function (l) {
      if (l.p === null) return 'fuera de alcance';
      return l.exporta ? 'exportar' : 'segregar';
    });

    tarjetas.append('p').attr('class', 'ct-plan-finca').text(function (l) {
      return l.Finca + ' · ' + l.Empresa_Exportadora;
    });

    var riesgo = tarjetas
      .filter(function (l) { return l.p !== null; })
      .append('div')
      .attr('class', 'ct-plan-riesgo');

    riesgo
      .append('span')
      .attr('class', 'ct-plan-barra-p')
      .append('span')
      .attr('class', function (l) {
        if (l.p >= 0.5) return 'is-alto';
        if (l.p >= CT.Optimizer.CONFIG.ALFA_CONTENEDOR) return 'is-medio';
        return '';
      })
      .style('width', function (l) { return Math.max(2, l.p * 100) + '%'; });

    riesgo.append('span').attr('class', 'ct-plan-p').text(function (l) {
      return fmtPct(l.p);
    });
    riesgo.append('span').attr('class', 'ct-plan-origen').text(function (l) {
      return ETIQUETA_ORIGEN[l.origen] || l.origen;
    });

    tarjetas.append('p').attr('class', 'ct-plan-motivo').text(function (l) {
      return l.motivo;
    });
  }

  function fmtPct(x) {
    return (x * 100).toFixed(1).replace('.0', '') + ' %';
  }

  /** Descarga el plan con las mismas columnas que emite el notebook. */
  function descargarPlanCSV() {
    if (!estado.plan) return;

    var columnas = [
      'lote_id', 'finca_id', 'finca', 'empresa_exportadora', 'peso_quintales',
      'destino_previsto', 'p_contaminado', 'origen_probabilidad',
      'en_cuarentena', 'decision', 'motivo', 'valor_asignado_usd'
    ];

    var filas = estado.plan.plan.map(function (l) {
      return [
        l.ID_Lote, l.ID_Productor, l.Finca, l.Empresa_Exportadora,
        l.quintales, l.Destino,
        l.p === null ? '' : l.p.toFixed(5),
        l.origen, l.enCuarentena ? 1 : 0, l.decision, l.motivo,
        l.valorAsignado.toFixed(2)
      ];
    });

    var csv = [columnas].concat(filas)
      .map(function (fila) {
        return fila
          .map(function (celda) {
            var texto = String(celda);
            // Los motivos llevan comas: van entre comillas y se escapan.
            return /[",\n]/.test(texto) ? '"' + texto.replace(/"/g, '""') + '"' : texto;
          })
          .join(',');
      })
      .join('\n');

    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'cafetrace-plan-segregacion-' +
      new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /* =====================================================================
     6. Formulario de alta de registros
     ===================================================================== */
  var NOMBRES_PANEL = CT.DataLoader.PANEL.map(function (a) { return a.nombre; });

  var CAMPOS = {
    productores: [
      { k: 'ID_Productor', label: 'ID Productor', ph: 'se asigna solo', req: false },
      { k: 'Nombre', label: 'Nombre', ph: 'Ana Ramirez', req: true },
      { k: 'Finca', label: 'Finca', ph: 'Finca El Mirador', req: true },
      { k: 'Coordenadas_Lat', label: 'Latitud', ph: '-6.2290', req: true, tipo: 'number' },
      { k: 'Coordenadas_Lon', label: 'Longitud', ph: '-77.8570', req: true, tipo: 'number' },
      {
        k: 'Empresa_Exportadora',
        label: 'Empresa / exportadora',
        ph: 'Perhusa',
        req: true,
        dinamico: 'empresas'
      },
      {
        k: 'Certificacion_Declarada',
        label: 'Certificacion',
        req: true,
        opciones: ['Organico', 'Convencional']
      },
      {
        k: 'Proximidad_Finca_Convencional',
        label: 'Proximidad a convencional',
        req: true,
        opciones: ['Alta', 'Baja', 'N/A']
      }
    ],
    tests: [
      { k: 'ID_Test', label: 'ID Test', ph: 'se asigna solo', req: false },
      { k: 'ID_Productor', label: 'ID Productor', req: true, dinamico: 'productores' },
      { k: 'ID_Lote', label: 'ID Lote', req: true, dinamico: 'lotes' },
      {
        k: 'Agroquimico',
        label: 'Agroquimico (kit del panel)',
        req: true,
        opciones: NOMBRES_PANEL
      },
      // Los dos campos siguientes son excluyentes: el tipo de lectura lo
      // impone el kit, no el operador. sincronizarLectura() muestra el que
      // corresponde al agroquimico elegido y oculta el otro.
      {
        k: 'Valor_ppm',
        label: 'Concentracion (ppm)',
        ph: '0.05',
        req: true,
        tipo: 'number',
        step: '0.01',
        lectura: 'Cuantitativo'
      },
      {
        k: 'Resultado',
        label: 'Lectura del kit',
        req: true,
        opciones: ['No_Detectado', 'Detectado'],
        lectura: 'Cualitativo'
      },
      { k: 'Operador', label: 'Operador', ph: 'Ricardo', req: true }
    ],
    lotes: [
      { k: 'ID_Lote', label: 'ID Lote', ph: 'se asigna solo', req: false },
      { k: 'ID_Productor', label: 'ID Productor', req: true, dinamico: 'productores' },
      { k: 'Peso_Quintales', label: 'Peso (quintales)', ph: '100', req: true, tipo: 'number' },
      { k: 'Destino', label: 'Destino', ph: 'Alemania', req: true, dinamico: 'destinos' },
      {
        k: 'Estado_Transito',
        label: 'Estado de transito',
        req: true,
        opciones: ['En_Acopio', 'En_Transito', 'Vendido_Local', 'Pendiente']
      },
      {
        k: 'Estado_Seguridad',
        label: 'Estado de seguridad',
        req: true,
        opciones: ['Aprobado', 'Pendiente_Verificacion', 'Rechazado', 'No_Aplica']
      }
    ]
  };

  function opcionesDinamicas(cual) {
    var vals = new Set();

    if (cual === 'productores') {
      estado.registros.forEach(function (r) { vals.add(r.ID_Productor); });
      CT.DataLoader.leerLocales().productores.forEach(function (p) {
        vals.add(p.ID_Productor);
      });
    } else if (cual === 'empresas') {
      estado.registros.forEach(function (r) { vals.add(r.Empresa_Exportadora); });
    } else if (cual === 'destinos') {
      estado.registros.forEach(function (r) { vals.add(r.Destino); });
    } else {
      estado.registros.forEach(function (r) { vals.add(r.ID_Lote); });
    }

    return Array.from(vals).filter(Boolean).sort();
  }

  function renderFormulario() {
    var sel = document.querySelector('#form-entidad');
    var campos = document.querySelector('#form-campos');
    if (!sel || !campos) return;

    var entidad = sel.value;
    campos.innerHTML = '';

    CAMPOS[entidad].forEach(function (c) {
      var wrap = document.createElement('div');
      wrap.className = 'ct-field';
      if (c.lectura) wrap.dataset.lectura = c.lectura;

      var label = document.createElement('label');
      label.textContent = c.label;
      label.setAttribute('for', 'f-' + c.k);
      wrap.appendChild(label);

      var input;
      var lista = c.opciones || (c.dinamico ? opcionesDinamicas(c.dinamico) : null);

      if (lista) {
        input = document.createElement('select');
        lista.forEach(function (o) {
          var opt = document.createElement('option');
          opt.value = o;
          opt.textContent = o;
          input.appendChild(opt);
        });
      } else {
        input = document.createElement('input');
        input.type = c.tipo || 'text';
        if (c.step) input.step = c.step;
        if (c.ph) input.placeholder = c.ph;
      }

      input.id = 'f-' + c.k;
      input.name = c.k;
      if (c.req) input.required = true;
      wrap.appendChild(input);
      campos.appendChild(wrap);
    });

    if (entidad === 'tests') {
      var selAgro = document.querySelector('#f-Agroquimico');
      if (selAgro) {
        selAgro.addEventListener('change', sincronizarLectura);
        sincronizarLectura();
      }
    }
  }

  /**
   * Un kit ELISA reporta cuantitativo (ppm) o cualitativo (presencia), no
   * ambos. El panel declara cual, y el formulario se adapta: pedirle ppm al
   * operador de un kit cualitativo seria pedirle un dato que el kit no da.
   */
  function sincronizarLectura() {
    var selAgro = document.querySelector('#f-Agroquimico');
    if (!selAgro) return;

    var def = CT.DataLoader.definicionAgroquimico(selAgro.value);
    var lectura = def ? def.lectura : 'Cuantitativo';

    document.querySelectorAll('#form-campos .ct-field[data-lectura]').forEach(function (w) {
      var visible = w.dataset.lectura === lectura;
      w.hidden = !visible;
      var control = w.querySelector('input, select');
      if (control) control.required = visible;
    });

    var hint = document.querySelector('#form-lectura-hint');
    if (hint && def) {
      hint.textContent =
        'Kit ' + def.kit + ' · lectura ' + def.lectura.toLowerCase() +
        (def.umbral_ppm !== null
          ? ' · umbral ' + def.umbral_ppm.toFixed(2) + ' ppm'
          : ' · presencia/ausencia');
    }
  }

  function manejarSubmit(evento) {
    evento.preventDefault();

    var entidad = document.querySelector('#form-entidad').value;
    var registro = {};
    var faltantes = [];

    CAMPOS[entidad].forEach(function (c) {
      var el = document.querySelector('#f-' + c.k);
      if (!el) return;
      // Un campo oculto por el tipo de lectura no se exige ni se envia.
      if (el.closest('.ct-field').hidden) return;
      var valor = String(el.value).trim();
      if (c.req && !valor) faltantes.push(c.label);
      registro[c.k] = valor;
    });

    if (faltantes.length) {
      mostrarEstadoForm('Faltan campos: ' + faltantes.join(', '), 'error');
      return;
    }

    // El CSV de tests lleva Timestamp; lo generamos en el momento del alta,
    // que es exactamente cuando el operador corre el kit en el acopio.
    if (entidad === 'tests') {
      var def = CT.DataLoader.definicionAgroquimico(registro.Agroquimico);
      registro.Timestamp = new Date().toISOString();
      registro.Kit = def ? def.kit : 'ELISA generico';
      registro.Tipo_Lectura = def ? def.lectura : 'Cuantitativo';

      if (registro.Tipo_Lectura === 'Cuantitativo') {
        // Coherencia: el resultado cualitativo se deriva del umbral del kit,
        // no de lo que el operador elija por error en el desplegable.
        registro.Resultado =
          parseFloat(registro.Valor_ppm) > def.umbral_ppm
            ? 'Alerta_Contaminacion'
            : 'Aprobado';
      } else {
        registro.Valor_ppm = '';
      }
    }

    // El motor recalcula el riesgo; el campo del CSV queda como "declarado".
    if (entidad === 'lotes') registro.Riesgo_Calculado = 'Por_Calcular';

    // El alta viaja al servidor de ingesta si esta levantado, y solo cae a
    // localStorage cuando no lo esta. Ver modules/ingesta.
    var boton = document.querySelector('#form-registro button[type="submit"]');
    if (boton) boton.disabled = true;
    mostrarEstadoForm('Registrando…', 'ok');

    CT.Ingesta.registrar(entidad, registro)
      .then(function (res) {
        mostrarEstadoForm(res.mensaje, res.destino === 'csv' ? 'ok' : 'aviso');
        document.querySelector('#form-registro').reset();
        return recargar();
      })
      .catch(function (err) {
        mostrarEstadoForm('Rechazado: ' + err.message, 'error');
      })
      .finally(function () {
        if (boton) boton.disabled = false;
      });
  }

  function mostrarEstadoForm(mensaje, clase) {
    var el = document.querySelector('#form-estado');
    if (!el) return;
    el.textContent = mensaje;
    el.className = 'ct-form-estado is-' + clase;
    clearTimeout(el._t);
    el._t = setTimeout(function () {
      el.textContent = '';
      el.className = 'ct-form-estado';
    }, 4500);
  }

  /* =====================================================================
     6. Exportacion del ledger
     ===================================================================== */
  function descargarLedger() {
    var blob = new Blob([JSON.stringify(estado.ledger, null, 2)], {
      type: 'application/json'
    });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'cafetrace-ledger-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /* =====================================================================
     7. Ciclo de vida
     ===================================================================== */
  function recargar() {
    return CT.DataLoader.load().then(function (res) {
      estado.registros = res.registros;
      estado.ledger = res.ledger;

      // Los filtros repueblan sus combos con el dataset nuevo y devuelven
      // el subconjunto que sobrevive a la seleccion vigente.
      var visibles = filtros.actualizar(res.registros);
      aplicarVista(visibles, filtros.activos());

      // Deep link: ?lote=L204 o #L204 abre directamente ese pasaporte.
      // Sirve para compartir el caso puntual con el comprador o el auditor.
      if (!estado.seleccion) {
        var pedido = loteDeLaURL();
        if (pedido) {
          var destino = res.registros.find(function (r) {
            return r.ID_Lote.toUpperCase() === pedido;
          });
          if (destino) seleccionarLote(destino);
        }
      }

      // Si el lote seleccionado sigue existiendo, refrescamos su arbol.
      if (estado.seleccion) {
        var vigente = res.registros.find(function (r) {
          return r.ID_Lote === estado.seleccion.ID_Lote;
        });
        if (vigente) seleccionarLote(vigente);
        else {
          estado.seleccion = null;
          arbol.limpiar();
        }
      }

      // Refrescamos los desplegables dependientes del dataset.
      renderFormulario();

      setTexto(
        '#origen-datos',
        'Fuente: ' + res.crudos.origen.lotes + ' · ' + CT.Ingesta.etiqueta()
      );
      var cabecera = document.querySelector('#origen-datos');
      if (cabecera) {
        cabecera.classList.toggle('is-escribe', CT.Ingesta.modo === 'servidor');
      }

      return res;
    });
  }

  /** Lee el lote pedido por URL (?lote=L204 o #L204). */
  function loteDeLaURL() {
    var params = new URLSearchParams(global.location.search);
    var id = params.get('lote') || global.location.hash.replace('#', '');
    return id ? id.trim().toUpperCase() : null;
  }

  function init() {
    mapa = CT.MapRisk.crear('#mapa-riesgo', { onSelect: seleccionarLote });
    arbol = CT.TreeTrace.crear('#arbol-trazabilidad');
    feed = CT.AlertsFeed.crear('#panel-alertas', { onSelect: seleccionarLote });
    filtros = CT.MapFilters.crear('#filtros-mapa', { onChange: aplicarVista });

    // Sin servidor, la clave la genera el navegador. Se le da a la capa de
    // ingesta la lista de identificadores ya usados para que no repita.
    CT.Ingesta.proveedorIds = function (entidad) {
      var ids = new Set();
      var locales = CT.DataLoader.leerLocales();

      if (entidad === 'productores') {
        estado.registros.forEach(function (r) { ids.add(r.ID_Productor); });
        locales.productores.forEach(function (p) { ids.add(p.ID_Productor); });
      } else if (entidad === 'lotes') {
        estado.registros.forEach(function (r) { ids.add(r.ID_Lote); });
        locales.lotes.forEach(function (l) { ids.add(l.ID_Lote); });
      } else {
        estado.registros.forEach(function (r) {
          (r.Tests || []).forEach(function (t) { ids.add(t.ID_Test); });
        });
        locales.tests.forEach(function (t) { ids.add(t.ID_Test); });
      }

      return Array.from(ids).filter(Boolean);
    };

    renderLeyenda();

    var selEntidad = document.querySelector('#form-entidad');
    if (selEntidad) selEntidad.addEventListener('change', renderFormulario);

    var form = document.querySelector('#form-registro');
    if (form) form.addEventListener('submit', manejarSubmit);

    var btnLimpiar = document.querySelector('#btn-limpiar');
    if (btnLimpiar) {
      btnLimpiar.addEventListener('click', function () {
        if (!global.confirm('Se eliminaran todos los registros agregados localmente. Continuar?')) return;
        CT.DataLoader.limpiarRegistrosLocales();
        estado.seleccion = null;
        arbol.limpiar();
        recargar();
      });
    }

    var btnLedger = document.querySelector('#btn-ledger');
    if (btnLedger) btnLedger.addEventListener('click', descargarLedger);

    // La tolerancia es una clausula comercial, no un parametro tecnico:
    // cambiarla resuelve el modelo de nuevo, en el navegador y al instante.
    var selAlfa = document.querySelector('#plan-alfa');
    if (selAlfa) selAlfa.addEventListener('change', renderPlan);

    var btnPlan = document.querySelector('#btn-plan-csv');
    if (btnPlan) btnPlan.addEventListener('click', descargarPlanCSV);

    renderFormulario();

    // Primero se decide donde se escriben las altas, porque de eso depende
    // si hay que subir lo que quedo guardado en el navegador antes de leer.
    Promise.all([CT.Ingesta.detectar(), CT.Optimizer.cargarPriors()])
      .then(function (res) {
        var info = res[0];
        if (info.migrados) {
          mostrarEstadoForm(
            info.migrados + ' alta(s) local(es) subida(s) al CSV.',
            'ok'
          );
        }
        return recargar();
      })
      .catch(function (err) {
        console.error('[CafeTrace] Error al inicializar el dashboard.', err);
        setTexto('#origen-datos', 'Error al cargar datos: ' + err.message);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  CT.App = {
    estado: estado,
    recargar: recargar,
    seleccionarLote: seleccionarLote,
    renderPlan: renderPlan
  };
})(window);
