/* ==========================================================================
   CafeTrace · captura.js
   --------------------------------------------------------------------------
   Formulario de captura de campo.

   Dos cosas viajan al servidor por cada envio:

     1. El resultado del kit, que va al CSV que lee el tablero.
     2. El registro del cuaderno de campo, que va a la capa cruda que
        consume el pipeline de aprendizaje.

   Ambas comparten el mismo lote, asi que se capturan juntas y el servidor
   las separa. El bloque del cuaderno es opcional: si el tecnico no lo abre,
   solo se envia el resultado del kit.

   Modo sin conexion. En campo la senal se cae. Si el envio falla, el
   registro queda en una cola en el dispositivo y se reintenta solo cuando
   el servidor vuelve a responder. Es el mismo comportamiento que tendria una
   aplicacion progresiva instalada, sin el peso de un trabajador de servicio.
   ========================================================================== */
(function () {
  'use strict';

  var API = '/api';
  var CLAVE_COLA = 'cafetrace.captura.cola.v1';

  var estado = {
    conectado: false,
    catalogo: null,
    historial: []
  };

  var el = {};

  /* =====================================================================
     Utilidades
     ===================================================================== */
  function $(id) {
    return document.getElementById(id);
  }

  function texto(nodo, valor, clase) {
    if (!nodo) return;
    nodo.textContent = valor;
    if (clase !== undefined) nodo.className = nodo.className.split(' ')[0] + (clase ? ' ' + clase : '');
  }

  function pedir(ruta, opciones) {
    return fetch(API + ruta, opciones).then(function (res) {
      return res.json().then(function (cuerpo) {
        if (!res.ok) throw new Error(cuerpo.error || ('HTTP ' + res.status));
        return cuerpo;
      });
    });
  }

  /* =====================================================================
     Cola local para trabajo sin conexion
     ===================================================================== */
  function leerCola() {
    try {
      return JSON.parse(localStorage.getItem(CLAVE_COLA) || '[]');
    } catch (e) {
      return [];
    }
  }

  function guardarCola(cola) {
    try {
      localStorage.setItem(CLAVE_COLA, JSON.stringify(cola));
    } catch (e) {
      console.warn('[CafeTrace] no se pudo guardar la cola local', e);
    }
  }

  function encolar(envio) {
    var cola = leerCola();
    cola.push(envio);
    guardarCola(cola);
    return cola.length;
  }

  /**
   * Vacia la cola contra el servidor. Se detiene al primer fallo para no
   * perder el orden de captura ni duplicar filas.
   */
  function drenarCola() {
    var cola = leerCola();
    if (!cola.length) return Promise.resolve(0);

    var enviados = 0;

    function siguiente() {
      if (!cola.length) {
        guardarCola([]);
        return Promise.resolve(enviados);
      }
      var envio = cola[0];
      return enviarAlServidor(envio)
        .then(function () {
          cola.shift();
          enviados += 1;
          guardarCola(cola);
          return siguiente();
        })
        .catch(function () {
          guardarCola(cola);
          return enviados;
        });
    }

    return siguiente();
  }

  /* =====================================================================
     Conexion y catalogo
     ===================================================================== */
  function detectar() {
    return pedir('/estado', { cache: 'no-store' })
      .then(function (info) {
        estado.conectado = true;
        var n = info.conteos.tests;
        texto(
          el.conexion,
          'servidor local activo · ' + n + ' resultados en CSV',
          'is-ok'
        );
        return drenarCola().then(function (enviados) {
          if (enviados) {
            marcarEstado(enviados + ' registro(s) en cola enviados al reconectar', 'ok');
            pintarHistorial();
          }
          return info;
        });
      })
      .catch(function () {
        estado.conectado = false;
        var pendientes = leerCola().length;
        texto(
          el.conexion,
          'sin servidor · ' + pendientes + ' en cola local',
          'is-off'
        );
        return null;
      });
  }

  function cargarCatalogo() {
    return pedir('/catalogo')
      .then(function (cat) {
        estado.catalogo = cat;
        poblarLotes(cat.lotes);
        poblarPanel(cat.panel);
        poblarOperadores(cat.operadores);
      })
      .catch(function () {
        // Sin catalogo el formulario sigue siendo utilizable: los combos
        // pasan a campos de texto libre.
        degradarACamposLibres();
      });
  }

  function poblarLotes(lotes) {
    el.lote.innerHTML = '';
    lotes.forEach(function (l) {
      var opt = document.createElement('option');
      opt.value = l.id_lote;
      opt.textContent = l.id_lote + (l.finca ? ' · ' + l.finca : '');
      opt.dataset.productor = l.id_productor;
      opt.dataset.finca = l.finca;
      el.lote.appendChild(opt);
    });
    pintarInfoLote();
  }

  function poblarPanel(panel) {
    el.agro.innerHTML = '';
    panel.forEach(function (a) {
      var opt = document.createElement('option');
      opt.value = a.agroquimico;
      opt.textContent = a.agroquimico;
      opt.dataset.lectura = a.tipo_lectura;
      opt.dataset.kit = a.kit;
      opt.dataset.umbral = a.umbral_ppm === null ? '' : a.umbral_ppm;
      opt.dataset.clase = a.clase || '';
      el.agro.appendChild(opt);
    });
    sincronizarLectura();
  }

  function poblarOperadores(operadores) {
    el.operadores.innerHTML = '';
    (operadores || []).forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o;
      el.operadores.appendChild(opt);
    });
  }

  function degradarACamposLibres() {
    [el.lote, el.agro].forEach(function (select) {
      if (select.options.length) return;
      var opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'sin catalogo, escribe el identificador';
      select.appendChild(opt);
    });
  }

  /* =====================================================================
     Reglas de la interfaz
     ===================================================================== */
  function opcionAgro() {
    return el.agro.options[el.agro.selectedIndex] || null;
  }

  /**
   * El tipo de lectura lo impone el kit, no el operador. Pedir ppm de un
   * kit cualitativo seria pedir un dato que el kit no entrega.
   */
  function sincronizarLectura() {
    var opt = opcionAgro();
    if (!opt) return;

    var cuantitativo = opt.dataset.lectura === 'Cuantitativo';

    el.campoPpm.hidden = !cuantitativo;
    el.campoLectura.hidden = cuantitativo;
    el.ppm.required = cuantitativo;

    texto(
      el.kitInfo,
      'kit ' + opt.dataset.kit + ' · lectura ' + opt.dataset.lectura.toLowerCase() +
        (opt.dataset.umbral ? ' · umbral ' + Number(opt.dataset.umbral).toFixed(2) + ' ppm'
                            : ' · presencia o ausencia')
    );
  }

  function pintarInfoLote() {
    var opt = el.lote.options[el.lote.selectedIndex];
    if (!opt || !opt.dataset.productor) {
      texto(el.loteInfo, '');
      return;
    }
    texto(el.loteInfo, 'productor ' + opt.dataset.productor + ' · ' + (opt.dataset.finca || ''));
  }

  function sincronizarFumigacion() {
    var valor = (document.querySelector('input[name="fumigo"]:checked') || {}).value;
    el.campoDias.hidden = valor !== 'Si';
  }

  /* =====================================================================
     Armado y envio
     ===================================================================== */
  function armarEnvio() {
    var optLote = el.lote.options[el.lote.selectedIndex];
    var optAgro = opcionAgro();

    var idLote = (optLote ? optLote.value : '').trim();
    var idProductor = optLote ? (optLote.dataset.productor || '') : '';
    var operador = el.operador.value.trim();

    if (!idLote) return { error: 'Selecciona un lote' };
    if (!operador) return { error: 'Indica el operador que corrio el kit' };

    var test = {
      ID_Productor: idProductor,
      ID_Lote: idLote,
      Agroquimico: optAgro ? optAgro.value : '',
      Operador: operador
    };

    if (optAgro && optAgro.dataset.lectura === 'Cuantitativo') {
      var ppm = el.ppm.value.trim();
      if (ppm === '') return { error: 'Este kit exige una concentracion en ppm' };
      if (Number(ppm) < 0) return { error: 'La concentracion no puede ser negativa' };
      test.Valor_ppm = ppm;
    } else {
      var marcada = document.querySelector('input[name="lectura"]:checked');
      test.Resultado = marcada ? marcada.value : 'No_Detectado';
    }

    var envio = { test: test, campo: null };

    // El cuaderno solo viaja si el tecnico lo abrio.
    if (!el.extra.hidden) {
      var fumigo = (document.querySelector('input[name="fumigo"]:checked') || {}).value || 'No';
      envio.campo = {
        lote_id: idLote,
        finca_id: idProductor,
        tecnico_id: operador,
        vecino_fumigo_reciente: fumigo,
        dias_desde_fumigacion_vecina:
          fumigo === 'Si' && el.dias.value !== '' ? Number(el.dias.value) : -1,
        despulpadora_compartida: el.form.despulpadora.checked,
        sacos_reutilizados: el.form.sacos.checked,
        secado_patio_compartido: el.form.patio.checked,
        transporte_compartido: el.form.transporte.checked,
        lavado_equipo_flag: el.form.lavado.checked,
        capacitacion_bpa_flag: el.form.capacitacion.checked,
        lat_gps: el.gps.dataset.lat || '',
        lon_gps: el.gps.dataset.lon || '',
        origen_captura: 'formulario_campo'
      };
    }

    return { envio: envio };
  }

  function enviarAlServidor(envio) {
    var cabeceras = { 'Content-Type': 'application/json' };

    return pedir('/registro', {
      method: 'POST',
      headers: cabeceras,
      body: JSON.stringify({ entidad: 'tests', datos: envio.test })
    }).then(function (respuesta) {
      if (!envio.campo) return respuesta;
      return pedir('/campo', {
        method: 'POST',
        headers: cabeceras,
        body: JSON.stringify({ datos: envio.campo })
      })
        .then(function () { return respuesta; })
        .catch(function (err) {
          // El resultado del kit ya quedo escrito. El cuaderno es
          // complementario: se avisa pero no se revierte la fila principal.
          console.warn('[CafeTrace] el cuaderno de campo no se pudo guardar', err);
          return respuesta;
        });
    });
  }

  function manejarSubmit(evento) {
    evento.preventDefault();

    var armado = armarEnvio();
    if (armado.error) {
      marcarEstado(armado.error, 'error');
      return;
    }

    el.guardar.disabled = true;
    marcarEstado('Guardando…', '');

    enviarAlServidor(armado.envio)
      .then(function (respuesta) {
        estado.conectado = true;
        agregarHistorial(armado.envio, respuesta.id, respuesta.fila.Resultado, 'ok');
        marcarEstado(
          'Guardado ' + respuesta.id + ' · fila ' + respuesta.filas + ' del CSV',
          'ok'
        );
        limpiarLecturaKit();
        return detectar();
      })
      .catch(function (err) {
        // Un rechazo de validacion no se debe encolar: el dato esta mal y
        // reintentarlo mil veces no lo va a arreglar.
        if (/exige|ya existe|Faltan|fuera del panel|negativa/i.test(err.message)) {
          marcarEstado(err.message, 'error');
          return;
        }
        var pendientes = encolar(armado.envio);
        estado.conectado = false;
        agregarHistorial(armado.envio, 'en cola', '', 'cola');
        marcarEstado(
          'Sin servidor. Registro en cola local (' + pendientes + ' pendiente(s))',
          'cola'
        );
        texto(el.conexion, 'sin servidor · ' + pendientes + ' en cola local', 'is-off');
        limpiarLecturaKit();
      })
      .finally(function () {
        el.guardar.disabled = false;
      });
  }

  /** Deja el lote y el operador puestos: se corren varios kits seguidos. */
  function limpiarLecturaKit() {
    el.ppm.value = '';
    var noDetectado = document.querySelector('input[name="lectura"][value="No_Detectado"]');
    if (noDetectado) noDetectado.checked = true;
    el.ppm.focus();
  }

  function marcarEstado(mensaje, clase) {
    texto(el.estado, mensaje, clase ? 'is-' + clase : '');
    clearTimeout(el.estado._t);
    if (mensaje) {
      el.estado._t = setTimeout(function () {
        texto(el.estado, '', '');
      }, 6000);
    }
  }

  /* =====================================================================
     Historial de la sesion
     ===================================================================== */
  function agregarHistorial(envio, id, resultado, clase) {
    estado.historial.unshift({
      id: id,
      lote: envio.test.ID_Lote,
      agro: envio.test.Agroquimico,
      lectura:
        envio.test.Valor_ppm !== undefined
          ? envio.test.Valor_ppm + ' ppm'
          : (envio.test.Resultado || '').replace(/_/g, ' ').toLowerCase(),
      alerta: resultado === 'Alerta_Contaminacion' || envio.test.Resultado === 'Detectado',
      clase: clase,
      hora: new Date().toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })
    });
    estado.historial = estado.historial.slice(0, 12);
    pintarHistorial();
  }

  function pintarHistorial() {
    el.historial.innerHTML = '';

    if (!estado.historial.length) {
      var vacio = document.createElement('li');
      vacio.className = 'cp-vacio';
      vacio.textContent = 'Aun no has guardado registros en esta sesion.';
      el.historial.appendChild(vacio);
      return;
    }

    estado.historial.forEach(function (h) {
      var li = document.createElement('li');
      li.className = h.clase === 'cola' ? 'is-cola' : h.alerta ? 'is-alerta' : 'is-ok';

      var id = document.createElement('span');
      id.className = 'cp-id';
      id.textContent = h.id;

      var det = document.createElement('span');
      det.className = 'cp-detalle';
      det.textContent = h.lote + ' · ' + h.agro + ' · ' + h.lectura;

      var hora = document.createElement('span');
      hora.className = 'cp-hora';
      hora.textContent = h.hora;

      li.appendChild(id);
      li.appendChild(det);
      li.appendChild(hora);
      el.historial.appendChild(li);
    });
  }

  /* =====================================================================
     GPS
     ===================================================================== */
  function capturarGPS() {
    if (!navigator.geolocation) {
      texto(el.gps, 'este dispositivo no expone GPS');
      return;
    }
    texto(el.gps, 'buscando senal…');
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        var lat = pos.coords.latitude.toFixed(6);
        var lon = pos.coords.longitude.toFixed(6);
        el.gps.dataset.lat = lat;
        el.gps.dataset.lon = lon;
        texto(el.gps, lat + ', ' + lon + ' (±' + Math.round(pos.coords.accuracy) + ' m)');
      },
      function (err) {
        texto(el.gps, 'sin GPS: ' + err.message);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  }

  /* =====================================================================
     Arranque
     ===================================================================== */
  function init() {
    el.form = $('cp-form');
    el.lote = $('cp-lote');
    el.loteInfo = $('cp-lote-info');
    el.agro = $('cp-agro');
    el.kitInfo = $('cp-kit-info');
    el.campoPpm = $('cp-campo-ppm');
    el.campoLectura = $('cp-campo-lectura');
    el.ppm = $('cp-ppm');
    el.operador = $('cp-operador');
    el.operadores = $('cp-operadores');
    el.extra = $('cp-campo-extra');
    el.campoDias = $('cp-campo-dias');
    el.dias = $('cp-dias');
    el.gps = $('cp-gps');
    el.guardar = $('cp-guardar');
    el.estado = $('cp-estado');
    el.conexion = $('cp-conexion');
    el.historial = $('cp-historial');

    el.lote.addEventListener('change', pintarInfoLote);
    el.agro.addEventListener('change', sincronizarLectura);
    el.form.addEventListener('submit', manejarSubmit);
    $('cp-btn-gps').addEventListener('click', capturarGPS);

    $('cp-toggle').addEventListener('click', function () {
      var abierto = !el.extra.hidden;
      el.extra.hidden = abierto;
      this.setAttribute('aria-expanded', String(!abierto));
      this.textContent = abierto ? 'mostrar' : 'ocultar';
    });

    Array.prototype.forEach.call(
      document.querySelectorAll('input[name="fumigo"]'),
      function (r) { r.addEventListener('change', sincronizarFumigacion); }
    );

    pintarHistorial();
    sincronizarFumigacion();

    detectar().then(cargarCatalogo);

    // Reintento periodico de la cola mientras la pagina siga abierta.
    setInterval(function () {
      if (leerCola().length) detectar();
    }, 30000);

    window.addEventListener('online', detectar);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
