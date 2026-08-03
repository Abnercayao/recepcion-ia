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

    var partes = [datos.latenciaMs + ' ms'];
    if (datos.herramientas && datos.herramientas.length) {
      for (var i = 0; i < datos.herramientas.length; i++) {
        partes.push(datos.herramientas[i].nombre + ':' + datos.herramientas[i].estado);
      }
    }
    var detalle = document.createElement('div');
    detalle.className = 'detalle';
    detalle.textContent = partes.join('  ·  ');
    detalle.hidden = !mostrandoDetalle;
    mensajes.appendChild(detalle);

    alFinal();
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
    var todos = mensajes.querySelectorAll('.detalle');
    for (var i = 0; i < todos.length; i++) todos[i].hidden = !mostrandoDetalle;
    alFinal();
  });

  // --- Saludo inicial -----------------------------------------------------
  // Estatico y a proposito: no gasta un turno de modelo, y la revelacion de
  // que es un asistente virtual queda dicha antes del primer mensaje.
  burbuja(
    'burbuja--agente',
    '¡Hola! 👋 Soy el asistente virtual de <strong>Clínica Dental Aurora</strong>. ' +
      'Puedo darte precios de referencia, horarios y ayudarte a agendar.<br><br>' +
      '¿En qué te ayudo?',
  );

  entrada.focus();
})();
