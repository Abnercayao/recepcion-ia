/* ---------------------------------------------------------------------------
   Chat de la web de demostracion.

   Habla con `POST /api/chat`, que corre en el proceso de Node. La clave del
   modelo NUNCA llega aqui: el navegador solo ve texto ya generado.

   Regla que no se rompe: la respuesta del modelo se inserta SIEMPRE escapada.
   Nada de lo que devuelva el servidor se interpreta como HTML.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  var mensajes = document.getElementById('mensajes');
  var formulario = document.getElementById('formulario');
  var entrada = document.getElementById('entrada');
  var enviar = document.getElementById('enviar');
  var sugerencias = document.getElementById('sugerencias');
  var alternarDetalle = document.getElementById('alternar-detalle');

  var mostrandoDetalle = false;
  var enCurso = false;

  /** Una sesion por pestana: dos pestanas son dos pacientes distintos. */
  var sesion = sessionStorage.getItem('aurora-sesion');
  if (!sesion) {
    sesion =
      Date.now().toString(36) +
      '-' +
      Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem('aurora-sesion', sesion);
  }

  // --- Utilidades ---------------------------------------------------------

  function escapar(texto) {
    var d = document.createElement('div');
    d.textContent = texto;
    return d.innerHTML;
  }

  /**
   * El prompt maestro usa *negritas* al estilo WhatsApp y **al estilo
   * markdown**. Se convierten a <strong> DESPUES de escapar, de modo que el
   * unico HTML que existe es el que ponemos nosotros.
   */
  function conNegritas(texto) {
    return escapar(texto)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,;:!?])/g, '$1<strong>$2</strong>');
  }

  function alFinal() {
    mensajes.scrollTop = mensajes.scrollHeight;
  }

  function burbuja(clase, html) {
    var div = document.createElement('div');
    div.className = 'burbuja ' + clase;
    div.innerHTML = html;
    mensajes.appendChild(div);
    alFinal();
    return div;
  }

  // --- Pintado ------------------------------------------------------------

  function pintarPaciente(texto) {
    burbuja('burbuja--paciente', escapar(texto));
  }

  function pintarAgente(datos) {
    burbuja('burbuja--agente', conNegritas(datos.texto));

    if (datos.escalamiento) {
      var aviso = document.createElement('div');
      aviso.className = 'escalamiento';
      aviso.innerHTML =
        '<strong>Te estamos pasando con una persona del equipo</strong>' +
        'Motivo: ' +
        escapar(datos.escalamiento.motivo) +
        ' · prioridad ' +
        escapar(datos.escalamiento.prioridad) +
        '. Si es una urgencia, llama al +51 999 000 001.';
      mensajes.appendChild(aviso);
    }

    var detalle = datos.traza
      ? pintarTraza(datos.traza)
      : (function () {
          var d = document.createElement('div');
          d.className = 'detalle';
          d.textContent = datos.latenciaMs + ' ms · sin traza';
          return d;
        })();
    detalle.hidden = !mostrandoDetalle;
    mensajes.appendChild(detalle);

    alFinal();
  }

  // --- Traza del turno ----------------------------------------------------
  //
  // Cada salto del turno con su duracion y su detalle. Es lo que convierte
  // «tardo 12 segundos» en «se llamo cuatro veces al modelo y tres fueron por
  // una herramienta que se pidio de mas».

  /** Colores por familia de salto. Deben existir en estilos.css. */
  function claseDeTipo(tipo) {
    return 'salto salto--' + String(tipo).replace(/[^a-z0-9]/gi, '');
  }

  function ms(n) {
    return Math.round(n) + ' ms';
  }

  /** Resumen de una linea: lo que hay que mirar antes de desplegar nada. */
  function lineaDeResumen(t) {
    var r = t.resumen;
    var partes = [ms(t.duracionMs)];

    partes.push(r.llamadasAlModelo + '× modelo (' + ms(r.msModelo) + ')');

    var nombres = Object.keys(r.herramientas || {});
    if (nombres.length) {
      var conteos = nombres.map(function (n) {
        return r.herramientas[n] > 1 ? n + '×' + r.herramientas[n] : n;
      });
      partes.push(conteos.join(' ') + ' (' + ms(r.msHerramientas) + ')');
    } else {
      partes.push('sin herramientas');
    }

    partes.push('RAG ' + r.ragEstrategia + ' → ' + r.fragmentos + ' frag. (' + ms(r.msRag) + ')');
    if (r.capa2 !== 'no actuo') partes.push('capa 2: ' + r.capa2);
    if (r.urgencia) partes.push('URGENCIA');
    if (r.escalado) partes.push('escalado');
    if (r.tokensIn || r.tokensOut) partes.push(r.tokensIn + '↓/' + r.tokensOut + '↑ tokens');

    return partes.join('  ·  ');
  }

  function pintarTraza(t) {
    var caja = document.createElement('details');
    caja.className = 'traza';

    var resumen = document.createElement('summary');
    resumen.className = 'traza__resumen';
    resumen.textContent = lineaDeResumen(t);
    caja.appendChild(resumen);

    var cuerpo = document.createElement('div');
    cuerpo.className = 'traza__cuerpo';

    // Escala comun para las barras: la duracion del salto mas largo. Asi se ve
    // de un golpe cual se lleva el turno.
    var maximo = 1;
    t.saltos.forEach(function (s) {
      if (s.duracionMs > maximo) maximo = s.duracionMs;
    });

    t.saltos.forEach(function (s) {
      var fila = document.createElement('details');
      fila.className = claseDeTipo(s.tipo) + (s.estado !== 'ok' ? ' salto--' + s.estado : '');

      var cabecera = document.createElement('summary');
      cabecera.className = 'salto__cabecera';

      var etiqueta = document.createElement('span');
      etiqueta.className = 'salto__nombre';
      etiqueta.textContent = s.n + '. ' + s.nombre;

      var barra = document.createElement('span');
      barra.className = 'salto__barra';
      var relleno = document.createElement('span');
      // Un salto instantaneo (una decision, un veredicto) no tiene barra:
      // pintarle una de ancho 0 lo haria parecer un error de medida.
      relleno.style.width = s.duracionMs > 0 ? Math.max(2, (s.duracionMs / maximo) * 100) + '%' : '0';
      barra.appendChild(relleno);

      var tiempo = document.createElement('span');
      tiempo.className = 'salto__tiempo';
      tiempo.textContent = s.duracionMs > 0 ? ms(s.duracionMs) : '+' + ms(s.desdeMs);

      cabecera.appendChild(etiqueta);
      cabecera.appendChild(barra);
      cabecera.appendChild(tiempo);
      fila.appendChild(cabecera);

      var json = document.createElement('pre');
      json.className = 'salto__detalle';
      json.textContent = JSON.stringify(s.detalle, null, 2);
      fila.appendChild(json);

      cuerpo.appendChild(fila);
    });

    // El tiempo no atribuido a ningun tramo medido. Si crece, es que hay que
    // instrumentar algo mas: es una pregunta abierta, no un relleno.
    if (t.resumen.msOtros > 0) {
      var otros = document.createElement('p');
      otros.className = 'traza__otros';
      otros.textContent =
        'Sin atribuir a ningun tramo medido: ' +
        ms(t.resumen.msOtros) +
        ' (persistencia, ensamblado del prompt y el propio recorrido del codigo).';
      cuerpo.appendChild(otros);
    }

    caja.appendChild(cuerpo);
    return caja;
  }

  function pintarError(texto) {
    burbuja('burbuja--error', escapar(texto));
  }

  function abrirEscritura() {
    var div = document.createElement('div');
    div.className = 'escribiendo';
    div.setAttribute('aria-label', 'Escribiendo');
    div.innerHTML = '<span></span><span></span><span></span>';
    mensajes.appendChild(div);
    alFinal();
    return div;
  }

  // --- Envio --------------------------------------------------------------

  function bloquear(si) {
    enCurso = si;
    entrada.disabled = si;
    enviar.disabled = si;
    if (!si) entrada.focus();
  }

  async function enviarMensaje(texto) {
    if (enCurso) return;
    texto = (texto || '').trim();
    if (!texto) return;

    if (sugerencias) sugerencias.hidden = true;

    pintarPaciente(texto);
    entrada.value = '';
    bloquear(true);

    var escribiendo = abrirEscritura();

    try {
      var res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ texto: texto, sesion: sesion }),
      });

      escribiendo.remove();

      if (!res.ok) {
        var fallo = await res.json().catch(function () {
          return {};
        });
        pintarError(fallo.error || 'No se pudo enviar el mensaje.');
        return;
      }

      pintarAgente(await res.json());
    } catch (e) {
      escribiendo.remove();
      pintarError('Sin conexión con el servidor. ¿Sigue corriendo `npm run demo:web`?');
    } finally {
      bloquear(false);
    }
  }

  // --- Enlaces de la interfaz ---------------------------------------------

  formulario.addEventListener('submit', function (e) {
    e.preventDefault();
    enviarMensaje(entrada.value);
  });

  if (sugerencias) {
    sugerencias.addEventListener('click', function (e) {
      var boton = e.target.closest('button[data-texto]');
      if (boton) enviarMensaje(boton.getAttribute('data-texto'));
    });
  }

  alternarDetalle.addEventListener('click', function () {
    mostrandoDetalle = !mostrandoDetalle;
    alternarDetalle.setAttribute('aria-pressed', String(mostrandoDetalle));
    var todos = mensajes.querySelectorAll('.detalle, .traza');
    for (var i = 0; i < todos.length; i++) todos[i].hidden = !mostrandoDetalle;
    if (panelVoz) panelVoz.hidden = !mostrandoDetalle;
    if (mostrandoDetalle) refrescarVoz();
    alFinal();
  });

  // --- Traza del canal de VOZ ---------------------------------------------
  //
  // Vive en OTRO proceso (el nucleo, puerto 3000) y en modo alojado ni siquiera
  // pasa por nuestro orquestador: razona el modelo del proveedor y lo unico que
  // toca nuestro codigo son los webhooks de las herramientas. Se pide al
  // servidor de esta web, que lo reenvia con el secreto puesto.

  var panelVoz = document.getElementById('panel-voz');
  var listaVoz = document.getElementById('lista-voz');
  var estadoVoz = document.getElementById('estado-voz');
  var refrescarBoton = document.getElementById('refrescar-voz');

  async function refrescarVoz() {
    if (!panelVoz) return;
    estadoVoz.textContent = 'consultando el núcleo…';
    try {
      var res = await fetch('/api/trazas');
      var datos = await res.json();

      listaVoz.innerHTML = '';

      if (datos.vozError) {
        // Se dice POR QUE no hay nada. Una lista vacia se lee como «no ha
        // pasado nada», y casi siempre significa «el nucleo no esta levantado».
        estadoVoz.textContent = 'No se pudo leer el canal de voz: ' + datos.vozError;
        return;
      }

      if (!datos.voz.length) {
        estadoVoz.textContent =
          'El núcleo responde, pero todavía no ha registrado ninguna llamada de voz.';
        return;
      }

      estadoVoz.textContent = datos.voz.length + ' evento(s) de voz, del más reciente al más antiguo.';
      datos.voz.forEach(function (t) {
        var bloque = document.createElement('div');
        bloque.className = 'voz__evento';

        var titulo = document.createElement('p');
        titulo.className = 'voz__titulo';
        titulo.textContent =
          new Date(t.abiertoEn).toLocaleTimeString('es-PE') +
          ' · ' +
          t.canal +
          ' · ' +
          t.entrada;
        bloque.appendChild(titulo);

        var salida = document.createElement('p');
        salida.className = 'voz__salida';
        salida.textContent = '→ ' + t.salida;
        bloque.appendChild(salida);

        bloque.appendChild(pintarTraza(t));
        listaVoz.appendChild(bloque);
      });
    } catch (e) {
      estadoVoz.textContent = 'No se pudo consultar: ' + e.message;
    }
  }

  if (refrescarBoton) refrescarBoton.addEventListener('click', refrescarVoz);

  // --- Saludo inicial -----------------------------------------------------
  // Estatico y a proposito: no gasta un turno de modelo, y la revelacion de
  // que es un asistente virtual queda dicha antes del primer mensaje.
  burbuja(
    'burbuja--agente',
    '¡Hola! 👋 Soy el asistente virtual de <strong>Clínica Aurora</strong>. ' +
      'Puedo confirmarte coberturas de EPS, precios de referencia, sedes y horarios, ' +
      'y ayudarte a agendar.<br><br>¿En qué te ayudo?',
  );

  entrada.focus();
})();
