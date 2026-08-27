/* ==========================================================================
   CafeTrace · app.js
   --------------------------------------------------------------------------
   Controlador principal del dashboard.

   Flujo:
     DataLoader.load()  ->  registros + KPIs + ledger
                        ->  KPIs en cabecera
                        ->  MapRisk (columna izquierda)
                        ->  AlertsFeed (columna derecha)
                        ->  TreeTrace (seccion inferior, bajo demanda)

   Tambien gestiona el formulario de alta de registros, que persiste en
   localStorage y vuelve a ejecutar todo el pipeline (join + reglas + KPIs)
   sin recargar la pagina.
   ========================================================================== */
(function (global) {
  'use strict';

  var CT = (global.CT = global.CT || {});

  var estado = {
    registros: [],
    kpis: null,
    ledger: null,
    seleccion: null
  };

  var mapa, arbol, feed;

  var fmtEntero = d3.format(',.0f');
  var fmtDecimal = d3.format('.1f');

  /* =====================================================================
     1. KPIs
     ===================================================================== */
  function renderKPIs(k) {
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
      k.lotesSinTest + ' lote(s) organico(s) sin test ELISA'
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
  }

  function setTexto(sel, texto) {
    var el = document.querySelector(sel);
    if (el) el.textContent = texto;
  }

  /* =====================================================================
     2. Seleccion de lote (mapa <-> alertas <-> arbol)
     ===================================================================== */
  function seleccionarLote(registro) {
    estado.seleccion = registro;
    mapa.seleccionar(registro.ID_Lote);
    arbol.mostrar(registro);

    setTexto(
      '#trace-subtitulo',
      registro.ID_Lote + ' · ' + registro.Finca + ' · ' + registro.Nombre
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
     3. Leyenda del mapa
     ===================================================================== */
  function renderLeyenda() {
    var cont = d3.select('#mapa-leyenda');
    cont.selectAll('*').remove();

    [
      ['Bajo', 'Conforme'],
      ['Medio', 'Deriva potencial'],
      ['Alto', 'Sin verificar'],
      ['Critico', 'Glifosato detectado'],
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
     4. Formulario de alta de registros
     ===================================================================== */
  var CAMPOS = {
    productores: [
      { k: 'ID_Productor', label: 'ID Productor', ph: 'P007', req: true },
      { k: 'Nombre', label: 'Nombre', ph: 'Ana Ramirez', req: true },
      { k: 'Finca', label: 'Finca', ph: 'Finca El Mirador', req: true },
      { k: 'Coordenadas_Lat', label: 'Latitud', ph: '-6.2290', req: true, tipo: 'number' },
      { k: 'Coordenadas_Lon', label: 'Longitud', ph: '-77.8570', req: true, tipo: 'number' },
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
      { k: 'ID_Test', label: 'ID Test', ph: 'T106', req: true },
      { k: 'ID_Productor', label: 'ID Productor', req: true, dinamico: 'productores' },
      { k: 'ID_Lote', label: 'ID Lote', req: true, dinamico: 'lotes' },
      {
        k: 'Glifosato_ppm',
        label: 'Glifosato (ppm)',
        ph: '0.05',
        req: true,
        tipo: 'number',
        step: '0.01'
      },
      {
        k: 'Resultado',
        label: 'Resultado',
        req: true,
        opciones: ['Aprobado', 'Alerta_Contaminacion']
      },
      { k: 'Operador', label: 'Operador', ph: 'Ricardo', req: true }
    ],
    lotes: [
      { k: 'ID_Lote', label: 'ID Lote', ph: 'L207', req: true },
      { k: 'ID_Productor', label: 'ID Productor', req: true, dinamico: 'productores' },
      { k: 'Peso_Quintales', label: 'Peso (quintales)', ph: '100', req: true, tipo: 'number' },
      { k: 'Destino', label: 'Destino', ph: 'Alemania', req: true },
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
    if (cual === 'productores') {
      var ids = new Set();
      estado.registros.forEach(function (r) { ids.add(r.ID_Productor); });
      CT.DataLoader.leerLocales().productores.forEach(function (p) {
        ids.add(p.ID_Productor);
      });
      return Array.from(ids).sort();
    }
    return estado.registros
      .map(function (r) { return r.ID_Lote; })
      .sort();
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
  }

  function manejarSubmit(evento) {
    evento.preventDefault();

    var entidad = document.querySelector('#form-entidad').value;
    var registro = {};
    var faltantes = [];

    CAMPOS[entidad].forEach(function (c) {
      var el = document.querySelector('#f-' + c.k);
      var valor = el ? String(el.value).trim() : '';
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
      registro.Timestamp = new Date().toISOString();
      // Coherencia: el resultado cualitativo se deriva del umbral, no de
      // lo que el operador elija por error en el desplegable.
      var umbral = CT.DataLoader.CONFIG.UMBRAL_GLIFOSATO_PPM;
      registro.Resultado =
        parseFloat(registro.Glifosato_ppm) > umbral ? 'Alerta_Contaminacion' : 'Aprobado';
    }

    // El motor recalcula el riesgo; el campo del CSV queda como "declarado".
    if (entidad === 'lotes') registro.Riesgo_Calculado = 'Por_Calcular';

    CT.DataLoader.agregarRegistro(entidad, registro);
    mostrarEstadoForm('Registro agregado. Pipeline recalculado.', 'ok');
    document.querySelector('#form-registro').reset();

    recargar();
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
     5. Exportacion del ledger
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
     6. Ciclo de vida
     ===================================================================== */
  function recargar() {
    return CT.DataLoader.load().then(function (res) {
      estado.registros = res.registros;
      estado.kpis = res.kpis;
      estado.ledger = res.ledger;

      renderKPIs(res.kpis);
      mapa.actualizar(res.registros);
      var alertas = feed.actualizar(res.registros);

      setTexto('#alertas-contador', alertas.length + ' alerta(s)');

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
        else arbol.limpiar();
      }

      // Refrescamos los desplegables dependientes del dataset.
      renderFormulario();

      setTexto(
        '#origen-datos',
        'Fuente: ' + res.crudos.origen.lotes +
          (res.crudos.origen.altasLocales
            ? ' · ' + res.crudos.origen.altasLocales + ' alta(s) local(es)'
            : '')
      );

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

    renderFormulario();

    recargar().catch(function (err) {
      console.error('[CafeTrace] Error al inicializar el dashboard.', err);
      setTexto('#origen-datos', 'Error al cargar datos: ' + err.message);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  CT.App = { estado: estado, recargar: recargar, seleccionarLote: seleccionarLote };
})(window);
