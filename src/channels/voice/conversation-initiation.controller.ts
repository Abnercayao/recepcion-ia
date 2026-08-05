/**
 * Webhook de INICIACION de conversacion.
 *
 * ElevenLabs lo llama cuando entra una llamada de Twilio, ANTES de que el
 * agente hable, y espera de vuelta un `conversation_initiation_client_data`.
 * Es la via por la que se inyectan `clinic_id`, `session_id` y el telefono en
 * una llamada ENTRANTE, donde no hay SDK cliente que los pase.
 *
 * `docs/fase5-elevenlabs.md` marcaba esto como «el hueco mas grande» y decia
 * que no estaba verificado que existiera una via equivalente. La hay, y es
 * esta. Sin este endpoint el gateway no sabe de que clinica se trata: responde
 * con el mensaje de respaldo y deriva a una persona en CADA llamada.
 *
 * Ademas es el unico sitio donde se puede crear la fila de `calls` antes del
 * primer turno. Sin ella, `voice-session.service` avisa —«turno de voz sin
 * registro en calls»— y no se persisten ni la transcripcion ni las latencias.
 *
 * REGLA DE ORO: este endpoint NUNCA rompe la llamada. Si algo falla por dentro
 * responde igualmente un `conversation_initiation_client_data` valido con lo
 * que haya podido resolver. Colgarle el telefono a un paciente porque nuestra
 * base de datos tuvo un mal minuto no es un modo de fallo aceptable.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';

import type { AuditRepository, Clinic, Logger } from '../../core/types/index.js';
import type { MessageRouter } from '../../core/conversation/message.router.js';
import { TRAZA_NULA, type RecolectorDeTraza } from '../../core/observabilidad/traza.js';
import type { CallRepository } from './voice.types.js';

export const RUTA_INICIACION = '/webhooks/elevenlabs/conversation-initiation';
export const RUTA_INICIACION_CON_SECRETO =
  '/webhooks/elevenlabs/g/:secret/conversation-initiation';

export interface ConversationInitiationDeps {
  router: MessageRouter;
  calls: CallRepository;
  audit: AuditRepository;
  logger: Logger;
  /**
   * El MISMO `VOICE_GATEWAY_SECRET` del Custom LLM, a proposito. Los dos
   * endpoints protegen la misma frontera y en la misma direccion (ElevenLabs
   * hacia nosotros); es el `ELEVENLABS_WEBHOOK_SECRET` el que juega en la otra
   * direccion, firmando lo que el proveedor nos manda al colgar. Anadir un
   * cuarto secreto para la misma frontera solo multiplica lo que se puede
   * desincronizar.
   */
  gatewaySecret: string;
  /**
   * Clinica a la que pertenece el numero llamado. v1 mapea UN numero a UNA
   * clinica por entorno, igual que hace WhatsApp con `CLINIC_ID`. Cuando haya
   * varias, esto pasa a resolverse por `called_number`.
   */
  clinicId: string;
  clinica?: Clinic;
  proveedorSip?: string;
  /**
   * Instrumentacion. OPCIONAL. Aqui es donde se ve si una llamada arranco bien:
   * si no se resuelve el numero de origen, el agente puede informar pero no
   * agendar ni dar continuidad, y hoy eso solo se sabe leyendo el log del
   * proceso justo cuando pasa.
   */
  traza?: RecolectorDeTraza;
}

/**
 * De donde sale el numero de quien llama. La documentacion oficial no fija el
 * nombre del campo para la integracion de Twilio, asi que se prueban las
 * ubicaciones plausibles en vez de apostar por una. Si ninguna acierta se
 * registra el cuerpo con las claves de primer nivel (no los valores: llevan
 * PII) para poder ajustarlo con una llamada real delante.
 */
const CAMPOS_DE_ORIGEN = [
  ['caller_id'],
  ['from_number'],
  ['from'],
  ['call', 'from'],
  ['twilio', 'From'],
  ['conversation_initiation_client_data', 'dynamic_variables', 'system__caller_id'],
] as const;

const CAMPOS_DE_DESTINO = [
  ['called_number'],
  ['to_number'],
  ['to'],
  ['agent_number'],
  ['call', 'to'],
  ['twilio', 'To'],
] as const;

const CAMPOS_DE_LLAMADA = [['call_sid'], ['callSid'], ['call', 'sid'], ['twilio', 'CallSid']] as const;

function leerRuta(cuerpo: unknown, ruta: readonly string[]): string | undefined {
  let actual: unknown = cuerpo;
  for (const paso of ruta) {
    if (typeof actual !== 'object' || actual === null) return undefined;
    actual = (actual as Record<string, unknown>)[paso];
  }
  return typeof actual === 'string' && actual.trim() !== '' ? actual.trim() : undefined;
}

function primeraCoincidencia(
  cuerpo: unknown,
  rutas: readonly (readonly string[])[],
): string | undefined {
  for (const ruta of rutas) {
    const valor = leerRuta(cuerpo, ruta);
    if (valor !== undefined) return valor;
  }
  return undefined;
}

function cabecera(valor: string | string[] | undefined): string | undefined {
  if (Array.isArray(valor)) return valor[0];
  return valor;
}

/** Comparacion en tiempo constante para no filtrar el secreto por temporizacion. */
function iguales(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diferencia = 0;
  for (let i = 0; i < a.length; i += 1) diferencia |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferencia === 0;
}

/**
 * Las mismas TRES vias que el Custom LLM (`contrato-elevenlabs.md` §2): el
 * proveedor no documenta que header envia, asi que la unica que funciona con
 * certeza es el segmento en la ruta. El dialogo del panel permite ademas
 * anadir encabezados a mano, y por eso las otras dos siguen valiendo.
 */
function autenticado(request: FastifyRequest, secreto: string): boolean {
  if (secreto === '') return false;

  const enRuta = (request.params as { secret?: string } | undefined)?.secret;
  if (typeof enRuta === 'string' && iguales(enRuta, secreto)) return true;

  const propio = cabecera(request.headers['x-gateway-secret']);
  if (typeof propio === 'string' && iguales(propio, secreto)) return true;

  const auth = cabecera(request.headers.authorization);
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    if (iguales(auth.slice(7).trim(), secreto)) return true;
  }

  return false;
}

interface RespuestaDeIniciacion {
  type: 'conversation_initiation_client_data';
  dynamic_variables: Record<string, string>;
  conversation_config_override?: Record<string, unknown>;
}

export const conversationInitiationPlugin: FastifyPluginAsync<
  ConversationInitiationDeps
> = async (app, deps) => {
  const manejador = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<RespuestaDeIniciacion | undefined> => {
    if (!autenticado(request, deps.gatewaySecret)) {
      deps.logger.warn(
        { componente: 'conversation-initiation' },
        'iniciacion: peticion sin secreto valido, se rechaza con 401',
      );
      void reply.code(401).send({ error: 'no autorizado' });
      return undefined;
    }

    const cuerpo = request.body;
    const numeroOrigen = primeraCoincidencia(cuerpo, CAMPOS_DE_ORIGEN);
    const numeroDestino = primeraCoincidencia(cuerpo, CAMPOS_DE_DESTINO);
    const callSid = primeraCoincidencia(cuerpo, CAMPOS_DE_LLAMADA);

    // `session_id` es NUESTRO, no del proveedor: es la clave con la que el
    // gateway encontrara la llamada en cada turno.
    const sessionId = randomUUID();

    const traza = (deps.traza ?? TRAZA_NULA).abrir({
      canal: 'voz (iniciacion)',
      entrada: 'entra una llamada',
      sesion: sessionId,
    });
    traza.identificar({ clinicId: deps.clinicId });
    traza.marcar('webhook', 'iniciacion de conversacion', 'ok', {
      // Los NOMBRES de las claves, no los valores: el cuerpo lleva PII y esto
      // se sirve por HTTP. Con las claves basta para ajustar CAMPOS_DE_ORIGEN
      // contra una llamada real, que es para lo que hace falta.
      clavesRecibidas: typeof cuerpo === 'object' && cuerpo !== null ? Object.keys(cuerpo) : [],
      numeroOrigenResuelto: Boolean(numeroOrigen),
      numeroDestinoResuelto: Boolean(numeroDestino),
      callSidResuelto: Boolean(callSid),
      sessionId,
    });

    const variables: Record<string, string> = {
      clinic_id: deps.clinicId,
      session_id: sessionId,
    };
    if (deps.clinica) variables['clinica'] = deps.clinica.nombre;
    if (numeroOrigen) variables['phone'] = numeroOrigen;

    if (!numeroOrigen) {
      // Sin telefono no hay paciente al que atar la conversacion. La llamada
      // sigue: el agente podra informar, pero no agendar ni dar continuidad.
      deps.logger.error(
        {
          componente: 'conversation-initiation',
          clavesRecibidas:
            typeof cuerpo === 'object' && cuerpo !== null ? Object.keys(cuerpo) : [],
        },
        'iniciacion: no se encontro el numero de origen; revisa CAMPOS_DE_ORIGEN contra este cuerpo',
      );
      traza.marcar('webhook', 'SIN numero de origen: la llamada arranca degradada', 'error', {
        efecto: 'el agente puede informar, pero NO agendar ni dar continuidad multicanal',
        arreglo: 'revisa CAMPOS_DE_ORIGEN contra las claves recibidas de arriba',
      });
      traza.cerrar('iniciacion sin telefono');
      return { type: 'conversation_initiation_client_data', dynamic_variables: variables };
    }

    const medidor = traza.iniciar('enrutado', 'resolver paciente y registrar la llamada');
    try {
      // `route` resuelve paciente y conversacion respetando la ventana de
      // continuidad multicanal, y NO persiste ningun mensaje. Es exactamente lo
      // que hace falta aqui: la llamada aun no ha dicho nada.
      const contexto = await deps.router.route({
        clinicId: deps.clinicId,
        patientPhoneE164: numeroOrigen,
        text: '',
        channel: 'voice',
        receivedAt: new Date(),
        sessionId,
      });

      const llamada = await deps.calls.create({
        conversationId: contexto.conversationId,
        sessionId,
        callStatus: 'iniciada',
        ...(callSid ? { elevenlabsConversationId: callSid } : {}),
        ...(deps.proveedorSip ? { proveedorSip: deps.proveedorSip } : {}),
        numeroOrigen,
        ...(numeroDestino ? { numeroDestino } : {}),
        // El paciente aun no ha oido la revelacion: la dice el `first_message`
        // y quien la verifica con la transcripcion real es el webhook
        // post-llamada. Marcarla aqui seria afirmar sin evidencia.
        disclosureEjecutada: false,
      });

      await deps.audit.log(
        'llamada_iniciada',
        { call_id: llamada.id, session_id: sessionId, con_call_sid: Boolean(callSid) },
        deps.clinicId,
        contexto.conversationId,
      );

      deps.logger.info(
        {
          componente: 'conversation-initiation',
          callId: llamada.id,
          sessionId,
          conversationId: contexto.conversationId,
        },
        'iniciacion: llamada registrada',
      );

      medidor.fin({
        detalle: {
          callId: llamada.id,
          conversationId: contexto.conversationId,
          conversacionNueva: contexto.history.length === 0,
          cambioDeCanal: contexto.channelSwitched,
        },
      });
      traza.identificar({ conversationId: contexto.conversationId });
      traza.cerrar('llamada registrada; el agente ya puede agendar');
    } catch (error) {
      // La llamada NO se cae por esto. Se pierde la transcripcion y las
      // latencias de esta llamada, y queda dicho en el log por que.
      const mensaje = error instanceof Error ? error.message : String(error);
      deps.logger.error(
        { componente: 'conversation-initiation', error: mensaje },
        'iniciacion: no se pudo registrar la llamada; la conversacion continua sin persistencia de voz',
      );
      medidor.fin({
        estado: 'error',
        detalle: {
          error: mensaje,
          efecto: 'la llamada sigue, pero SIN transcripcion ni latencias persistidas',
        },
      });
      traza.cerrar('iniciacion degradada: sin persistencia de voz');
    }

    return { type: 'conversation_initiation_client_data', dynamic_variables: variables };
  };

  app.post(RUTA_INICIACION, manejador);
  // Via 3: el secreto en la ruta. La unica que funciona con certeza si el
  // proveedor no envia ningun header.
  app.post(RUTA_INICIACION_CON_SECRETO, manejador);
};
