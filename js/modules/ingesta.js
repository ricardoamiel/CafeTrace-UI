/* ==========================================================================
   CafeTrace · modules/ingesta.js
   --------------------------------------------------------------------------
   Puente entre el formulario del tablero y el servidor local de ingesta.

   El MVP guardaba las altas en localStorage y el CSV nunca cambiaba: el
   dato vivia en un solo navegador y el pipeline de aprendizaje no lo veia
   nunca. Este modulo resuelve eso sin perder la propiedad que hacia util
   el diseno original, que es abrir el tablero con doble clic y que funcione.

   Dos modos, decididos en arranque por una sola consulta de salud:

     servidor    hay un proceso de ingesta escuchando. Las altas se
                 escriben en los CSV de data y el tablero recarga desde
                 disco. El dato queda disponible para todos.

     local       no hay servidor, por ejemplo al abrir el archivo con doble
                 clic. Las altas caen en localStorage como antes. Es un
                 respaldo, no el destino final, y la cabecera lo dice.

   Al pasar de local a servidor, las altas que quedaron en el navegador se
   suben en orden y se limpian: nadie tiene que volver a teclearlas.
   ========================================================================== */
(function (global) {
  'use strict';

  var CT = (global.CT = global.CT || {});

  var API = '/api';

  var estado = {
    modo: 'local',      // 'servidor' o 'local'
    conteos: null,
    ultimoError: null
  };

  /* ---------------------------------------------------------------------
     Transporte
     --------------------------------------------------------------------- */
  function pedir(ruta, opciones) {
    // Sin fetch, o bajo el esquema de archivo local, ni siquiera se intenta:
    // el navegador lanzaria un error de red por cada alta.
    if (typeof fetch !== 'function' || global.location.protocol === 'file:') {
      return Promise.reject(new Error('sin transporte disponible'));
    }
    return fetch(API + ruta, opciones).then(function (res) {
      return res.json().then(function (cuerpo) {
        if (!res.ok) throw new Error(cuerpo.error || ('HTTP ' + res.status));
        return cuerpo;
      });
    });
  }

  /* ---------------------------------------------------------------------
     Deteccion del servidor
     --------------------------------------------------------------------- */
  function detectar() {
    return pedir('/estado', { cache: 'no-store' })
      .then(function (info) {
        var previo = estado.modo;
        estado.modo = 'servidor';
        estado.conteos = info.conteos;
        estado.ultimoError = null;
        // Recien conectado: subimos lo que quedo guardado en el navegador.
        return previo === 'servidor'
          ? { modo: 'servidor', migrados: 0 }
          : migrarLocales().then(function (n) {
              return { modo: 'servidor', migrados: n };
            });
      })
      .catch(function (err) {
        estado.modo = 'local';
        estado.ultimoError = err.message;
        return { modo: 'local', migrados: 0 };
      });
  }

  /**
   * Sube al servidor las altas que se hicieron sin conexion y vacia el
   * almacenamiento del navegador. Se detiene al primer fallo de red para
   * no perder el orden; un rechazo de validacion si se descarta, porque
   * reintentar un dato invalido no lo vuelve valido.
   */
  function migrarLocales() {
    var locales = CT.DataLoader.leerLocales();
    var pendientes = [];

    ['productores', 'lotes', 'tests'].forEach(function (entidad) {
      (locales[entidad] || []).forEach(function (registro) {
        pendientes.push({ entidad: entidad, datos: registro });
      });
    });

    if (!pendientes.length) return Promise.resolve(0);

    var subidos = 0;

    function siguiente(i) {
      if (i >= pendientes.length) return Promise.resolve(subidos);
      return enviar(pendientes[i].entidad, pendientes[i].datos)
        .then(function () {
          subidos += 1;
          return siguiente(i + 1);
        })
        .catch(function (err) {
          if (esRechazoDeValidacion(err)) {
            console.warn(
              '[CafeTrace] alta local descartada por validacion del servidor:',
              err.message
            );
            return siguiente(i + 1);
          }
          return subidos; // problema de red: se corta y se reintenta luego
        });
    }

    return siguiente(0).then(function (n) {
      if (n) CT.DataLoader.limpiarRegistrosLocales();
      return n;
    });
  }

  function esRechazoDeValidacion(err) {
    return /exige|ya existe|Faltan|fuera del panel|negativa|invalido/i.test(
      err.message || ''
    );
  }

  /* ---------------------------------------------------------------------
     Alta
     --------------------------------------------------------------------- */
  function enviar(entidad, datos) {
    return pedir('/registro', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entidad: entidad, datos: datos })
    });
  }

  /**
   * Alta de un registro por el camino que corresponda al modo vigente.
   * @returns {Promise<{destino:'csv'|'navegador', id:string, mensaje:string}>}
   */
  function registrar(entidad, datos) {
    if (estado.modo !== 'servidor') {
      // El servidor asigna la clave correlativa. Sin el, la genera el
      // navegador con la misma regla para que ambos modos sean canjeables.
      if (!datos[claveDe(entidad)]) {
        datos[claveDe(entidad)] = siguienteIdLocal(entidad);
      }
      CT.DataLoader.agregarRegistro(entidad, datos);
      return Promise.resolve({
        destino: 'navegador',
        id: datos[claveDe(entidad)] || '',
        mensaje: 'Guardado en este dispositivo. Levanta el servidor de ingesta para escribir en el CSV.'
      });
    }

    return enviar(entidad, datos)
      .then(function (res) {
        estado.conteos = null;
        return {
          destino: 'csv',
          id: res.id,
          mensaje: 'Registro ' + res.id + ' escrito en ' + res.archivo +
                   ' (fila ' + res.filas + ').'
        };
      })
      .catch(function (err) {
        if (esRechazoDeValidacion(err)) throw err;
        // Se cayo el servidor a mitad de sesion: no perdemos el dato.
        estado.modo = 'local';
        CT.DataLoader.agregarRegistro(entidad, datos);
        return {
          destino: 'navegador',
          id: datos[claveDe(entidad)] || '',
          mensaje: 'Servidor no disponible. Guardado en este dispositivo y se subira al reconectar.'
        };
      });
  }

  /**
   * Siguiente correlativo a partir de los identificadores ya usados. Toma
   * el maximo numerico y no el conteo, para que borrar una fila no genere
   * despues una clave repetida. Misma regla que aplica el servidor.
   */
  function siguienteIdLocal(entidad) {
    var prefijo = entidad === 'productores' ? 'P' : entidad === 'lotes' ? 'L' : 'T';
    var usados = (CT.Ingesta.proveedorIds ? CT.Ingesta.proveedorIds(entidad) : []) || [];
    var patron = new RegExp('^' + prefijo + '0*(\\d+)$', 'i');

    var maximo = usados.reduce(function (max, id) {
      var m = patron.exec(String(id).trim());
      return m ? Math.max(max, parseInt(m[1], 10)) : max;
    }, 0);

    return prefijo + String(maximo + 1).padStart(3, '0');
  }

  function claveDe(entidad) {
    if (entidad === 'productores') return 'ID_Productor';
    if (entidad === 'lotes') return 'ID_Lote';
    return 'ID_Test';
  }

  /** Etiqueta corta del modo, para la cabecera del tablero. */
  function etiqueta() {
    if (estado.modo === 'servidor') return 'escritura en CSV';
    var locales = CT.DataLoader.leerLocales();
    var n = locales.productores.length + locales.lotes.length + locales.tests.length;
    return n ? n + ' alta(s) solo en este dispositivo' : 'solo lectura';
  }

  CT.Ingesta = {
    estado: estado,
    // app.js lo reemplaza en arranque por la lista real de identificadores.
    proveedorIds: null,
    detectar: detectar,
    registrar: registrar,
    etiqueta: etiqueta,
    get modo() {
      return estado.modo;
    }
  };
})(window);
