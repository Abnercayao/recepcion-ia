# Fase 7 — Protocolo de auditoría de equidad del reconocimiento del habla

Implementa el control **C5** del informe ético-regulatorio (*"Equidad del
reconocimiento del habla y salidas alternativas"*) y mide directamente el
riesgo **A.1** (*"Sesgo de reconocimiento del habla por variedad dialectal"*).
Es la Fase 1 del modelo de auditoría interna del informe (§3.3.3.D): *"Registrar
la medición base de la tasa de error de palabra por segmento de hablante...
como línea de referencia obligatoria del canal de voz"*.

## 0. Qué es y qué no es este documento

Esto **no es la línea base**. Es el protocolo con el que se produce la línea
base cuando existan hablantes reales con consentimiento informado, más el
instrumento de cálculo (`scripts/wer.ts`) ya construido y probado. El informe
ético es explícito sobre el estado del proyecto: *"no se presentan resultados
empíricos de operación"* y los espacios que requieren evidencia real *"se
entregan con espacios de evidencia señalizados en lugar de contenido
fabricado"*. Este documento es uno de esos espacios: describe con precisión
qué hay que hacer y con qué criterio, para que cuando alguien lo ejecute con
personas reales, el resultado sea reproducible y defendible ante quien lo
audite.

No hay atajo posible aquí. Ver la sección 6.

## 1. Por qué existe esta fase

El riesgo A.1 del informe ético lo dice sin rodeos: los modelos de
reconocimiento automático del habla se entrenan predominantemente con
variedades estándar del castellano, y en el Perú eso implica una tasa de
error de palabra previsiblemente superior para hablantes con sustrato andino
o amazónico, bilingües de quechua o aimara, adultos mayores, y personas con
prótesis dental o patología bucal. El daño que describe el informe es
concreto: *"un paciente al que el sistema no entiende no obtiene su cita"*, y
lo hace de forma invisible, porque el registro solo muestra "conversación no
completada" sin indicar por qué. Probabilidad alta, impacto alto, y el
informe lo marca como el riesgo que **exige medición obligatoria antes del
despliegue, no monitoreo posterior**.

El control C5 responde con dos piezas, y esta fase construye el instrumental
para la primera y documenta cómo verificar la segunda:

1. **Medición de la tasa de error de palabra por segmento de hablante antes
   del despliegue.** Es `scripts/wer.ts` (ver su encabezado para el
   algoritmo, formato de entrada y salida) más el protocolo de este
   documento (secciones 2 a 4).
2. **Flujo de dos fallos y salida alternativa** durante la operación en vivo.
   Ya está construido en el núcleo (no es parte de esta rama); la sección 5
   describe exactamente qué se construyó y cómo verificarlo con audio real.

## 2. Segmentos de hablante a medir, y por qué

El informe nombra explícitamente cinco categorías de hablante en el riesgo
A.1. Se toman como los segmentos obligatorios, más una condición de captura
transversal que no es un segmento demográfico sino una condición acústica
que debe cruzarse con los anteriores, no medirse aislada:

| Segmento | Justificación contra el riesgo A.1 |
|---|---|
| **Limeña estándar** | No es un segmento "de riesgo": es el **grupo de control**. Sin un segmento de referencia contra el cual comparar, no existe "mejor segmento", y la brecha (sección 4) no se puede calcular. Es indispensable aunque no aparezca nombrado como riesgo. |
| **Andina** | Sustrato fonético y de entonación andino, con o sin quechua/aimara como lengua materna. Es la variedad que el informe nombra en primer lugar como subrepresentada en el entrenamiento del ASR. |
| **Amazónica** | Nombrada explícitamente en A.1. Variedad dialectal distinta de la andina, con presencia aún menor en corpora de entrenamiento — es razonable esperar que el sesgo sea igual o mayor que el andino, no se puede asumir que "no andino" equivale a "estándar". |
| **Bilingüe con quechua o aimara como lengua materna** | El caso más severo que nombra A.1 explícitamente. La interferencia fonológica de una L1 distinta del castellano es un mecanismo de sesgo diferente (y probablemente más severo) que el de un sustrato regional en un hablante monolingüe de castellano. Se mide como segmento propio, no fusionado con "andino", precisamente para no diluir esta señal. |
| **Adultos mayores** | Nombrado explícitamente en A.1. Cambios en la voz asociados a la edad (menor proyección, cambios en el ritmo del habla) son un mecanismo de sesgo distinto del dialectal y compuesto con él si el hablante mayor es además de sustrato andino o amazónico — de ahí que el guion de captura (sección 3) pida cruzar edad con variedad cuando sea posible. |
| **Personas con prótesis dental o patología bucal** | Nombrado explícitamente en A.1, y es el segmento que conecta más directo con el dominio: es una clínica **dental**, así que este grupo es, por definición del negocio, parte del público objetivo, no un caso marginal. Afecta la articulación de forma independiente del dialecto. |
| **Condición de captura: ruido de fondo típico** (calle, mercado, terminal) | **No es un octavo segmento demográfico**, es una condición acústica que debe cruzarse con al menos uno de los segmentos anteriores. Medir solo en condiciones de estudio (cabina silenciosa) fabricaría un WER optimista que no corresponde a cómo un paciente real llama desde la calle o desde un mercado. Un diseño de dos ejes (segmento × condición) es más caro de capturar pero es el único que no miente sobre la operación real. |

**Vacío de la especificación:** ningún documento fuente fija esta lista de
segmentos ni el cruce con condición acústica; se deriva directamente de la
enumeración literal de A.1 más el criterio de que sin grupo de control no
hay brecha que calcular. Si al ejecutar la captura real aparecen otros
segmentos relevantes para una clínica concreta (por ejemplo, una variedad
regional específica sobrerrepresentada en su cartera de pacientes), se
añaden como columnas adicionales del mismo archivo de entrada de
`scripts/wer.ts` — el script no asume una lista cerrada de segmentos, los
descubre del propio archivo.

## 3. Hablantes mínimos por segmento, y el guion de captura

### 3.1. Cuántos hablantes hacen falta

`scripts/wer.ts` implementa dos umbrales (`UMBRALES_POR_DEFECTO`,
configurables por `--min-absoluto` y `--min-hablantes`):

- **Mínimo absoluto: 5 hablantes.** Por debajo de esto el script marca el
  segmento como `insuficiente` y lo dice explícitamente en la consola y en
  las advertencias: el WER de 2 o 3 personas no distingue una diferencia
  sistemática de una racha de mala suerte con un micrófono defectuoso. Es
  ruido, no una conclusión, y el script lo trata igual que una brecha
  excedida a efectos del código de salida (bloquea).
- **Mínimo recomendado: 15 hablantes.** Por debajo de esto el WER se calcula
  y se reporta (nivel `minimo`), pero el script advierte que no alcanza para
  **sostener una decisión de despliegue**. Es el número mínimo con el que un
  intervalo de confianza aproximado (ver `intervaloWilson` en el script) deja
  de ser tan ancho que cualquier conclusión sea indefendible.

Ambos números son una decisión de esta rama, no un valor fijado por el
informe fuente, elegidos por ser el punto de partida habitual en auditorías
de sesgo con recursos limitados (suficiente para detectar una diferencia
grande, no para certificar una pequeña). **Deben recalibrarse** cuando exista
capacidad real de reclutamiento: si conseguir 15 hablantes bilingües de
quechua L1 con consentimiento resulta más caro o más lento de lo previsto,
eso en sí mismo es información sobre cuánto tiempo tomará esta fase, no un
motivo para bajar el umbral silenciosamente.

### 3.2. Guion de captura

Cada hablante lee (o se le pide decir con sus propias palabras, según la
fila) el mismo conjunto de frases, para que la referencia sea comparable
entre segmentos. El guion cubre los cinco intents del prompt maestro más los
dos casos que más le importan a esta auditoría: números/horas (para probar
que la normalización del script no infla el WER con diferencias de formato)
y frases que disparan el flujo de escalamiento.

| # | Frase (guía, no verbatim obligatorio) | Por qué está |
|---|---|---|
| 1 | "Hola, buenas tardes, quisiera sacar una cita" | Apertura típica — línea base de inteligibilidad. |
| 2 | Su nombre completo | Nombres propios son el caso más duro para cualquier ASR; varía fuerte por origen. |
| 3 | Una hora dicha de forma natural, ej. "a las cuatro y media de la tarde" | Prueba directa de la normalización de números del script (ver `convertirNumerosATexto`). |
| 4 | Una fecha con día de la semana y número, ej. "el martes veinte de enero" | Igual que arriba, con fecha compuesta. |
| 5 | "Sí, confirmo esa cita" / "Mejor cambiémosla" | Palabras de confirmación exactas que el prompt maestro exige reconocer literalmente (bloque de agendamiento). |
| 6 | Una queja o reclamo breve, ej. "no me gustó cómo me atendieron la vez pasada" | Dispara criterio de escalamiento 3; importa que el ASR conserve el tono, no solo las palabras. |
| 7 | Una frase con síntoma explícito, ej. "me duele la muela desde ayer" | Frecuente en el dominio real (ver informe ético, hallazgo 1.3); prueba la captura de vocabulario clínico coloquial. |
| 8 | Pedir explícitamente hablar con una persona | Dispara criterio de escalamiento 1; frase corta, alto valor si se pierde. |
| 9 | Repetir la frase 3 dos veces seguidas, como si el sistema no hubiera entendido | Insumo directo para verificar el flujo de dos fallos (sección 5) con el mismo hablante. |
| 10 | Una frase larga y natural sin guion, 15-20 segundos, sobre el motivo de la llamada | Habla espontánea real: prosodia, muletillas, pausas — lo que un guion leído no captura. |

Cada frase se captura, cuando sea posible, en **dos condiciones**: entorno
silencioso y con ruido de fondo típico (ver la fila de condición de captura
en la sección 2). El resultado de cada grabación pasa por transcripción
humana (la referencia) y por el ASR real que se vaya a usar en producción
(la hipótesis), y ambas se cargan a `scripts/wer.ts` con el formato de su
encabezado (`hablante_id`, `segmento`, `referencia`, `hipotesis`,
`frase_id` opcional para poder auditar qué frase generó qué error).

**La captura no empieza sin consentimiento firmado.** Ver
`docs/plantillas/consentimiento-informado.md`. No es un formalismo posterior:
la voz es dato biométrico (Tabla 1 del informe ético) y su tratamiento sin
base legal es, en sí mismo, uno de los riesgos que este proyecto se
comprometió a no correr (riesgo R5 de la matriz consolidada).

## 4. Umbral de brecha aceptable, y qué pasa si se supera

`scripts/wer.ts` calcula la **brecha** como la diferencia absoluta, en puntos
de WER, entre el segmento con mejor y peor desempeño
(`UMBRAL_BRECHA_POR_DEFECTO = 0.10`, es decir 10 puntos porcentuales,
configurable por `--umbral-brecha`).

**Por qué 10 puntos y no otro número:** es una decisión de esta rama, no un
valor que fije ningún documento fuente (vacío de la especificación). Se
eligió por ser lo bastante estrecho para no tolerar una exclusión sistemática
grande, y lo bastante amplio para no bloquear el despliegue por ruido de
medición normal entre segmentos con muestras moderadas. **Debe recalibrarse**
en cuanto exista una primera línea base real: si con hablantes reales la
brecha entre el mejor y el peor segmento resulta, por ejemplo, de 6 puntos de
forma consistente, un umbral de 10 puntos sería demasiado laxo para esta
operación concreta.

**Distinción importante con la Tabla 10 del informe ético:** el indicador de
gobernanza *"brecha de conversión a cita entre segmentos de hablante"* que se
monitorea **mensualmente, después del despliegue** (Fase 3 del modelo de
auditoría, §3.3.3.D) es una métrica de negocio (¿el paciente terminó agendando
o no?), distinta de la brecha de WER que mide este script **antes del
despliegue** (Fase 1 del mismo modelo). Son complementarias, no
intercambiables: la brecha de WER es la causa técnica más probable de una
eventual brecha de conversión, pero un paciente puede entender perfecto y aun
así no agendar por otros motivos. No se debe reportar una como sustituto de
la otra.

**Qué pasa si se supera (criterio bloqueante, sin excepciones):**

- `scripts/wer.ts` termina con **código de salida 1** cuando la brecha supera
  el umbral, cuando la comparación se apoya en un segmento con muestra por
  debajo del mínimo absoluto, o cuando no hay al menos dos segmentos con WER
  definido para comparar. Los tres casos se tratan igual porque los tres
  significan lo mismo: **no hay base para autorizar el canal de voz**.
- El anti-patrón 9 del brief lo dice de forma literal: *"Desplegar voz antes
  de la fase 7. Expone pacientes a un sesgo de magnitud desconocida"*. Un
  código de salida 1 de este script es, por diseño, un bloqueo de ese
  anti-patrón utilizable directamente como gate de CI/CD.
- La remediación **no es bajar el umbral**. Es (a) revisar si el prompt o la
  configuración del ASR tienen una palanca razonable (vocabulario
  personalizado, por ejemplo) antes de re-medir, y (b) si el segmento
  afectado sigue por debajo del umbral, **restringir el canal de voz para
  ese segmento** (ofrecer WhatsApp como canal por defecto) hasta corregir,
  en vez de suspender el proyecto completo o ignorar el hallazgo.

## 5. El flujo de dos fallos y salida alternativa (control C5), y cómo verificarlo con audio real

Esta pieza **ya está construida en el núcleo** (no es un archivo de esta
rama); esta sección documenta qué existe y cómo se verifica, porque el
criterio de aceptación de la Fase 7 lo pide explícitamente: *"el flujo de
dos-fallos-y-salida-alternativa verificado con audio real"*.

### 5.1. Qué existe hoy

- `TurnContext.comprehensionFailures` (`src/core/types/conversation.ts`):
  contador de fallos de comprensión consecutivos, con el comentario propio
  del campo: *"A los 2 se ofrece salida alternativa"*.
- `contarFallosDeComprension` y `esFalloDeComprension`
  (`src/core/conversation/message.router.ts`): el contador se reconstruye
  leyendo la cola del historial (no hay columna dedicada — vacío de la
  especificación documentado ahí mismo), buscando patrones de "no entendí" /
  "puede repetir" en los turnos del **asistente**, y se detiene en el primer
  turno que sí entendió (el contador vuelve a cero).
- `notasDeSesion` (`src/core/claude/prompt.builder.ts`): inyecta una nota en
  el prompt cuando `comprehensionFailures >= 2` indicando que se debe ofrecer
  de inmediato continuar por WhatsApp o hablar con una persona.
- El criterio 4 de escalamiento (`prompts/maestro.md`): *"Se acumulan DOS
  fallos de comprensión CONSECUTIVOS... Al segundo fallo, SIN que el
  paciente lo pida, ofreces las dos salidas... NUNCA hay un tercer intento"*.

### 5.2. La limitación que el audio real tiene que exponer

El mecanismo detecta el fallo **por el texto que el propio asistente
produce** ("no le entendí", "¿puede repetir?"), no por una señal del ASR
sobre su propia confianza de transcripción. Esto deja un caso sin cubrir, y
es precisamente el más relevante para el riesgo A.1: si el ASR transcribe
mal el habla de un hablante con acento marcado pero produce un texto
**plausible** (una palabra real, con sentido gramatical, solo que
incorrecta), el modelo puede responder con confianza a algo que el paciente
nunca dijo. Ahí no hay "no entendí" que contar, el contador nunca sube, y el
paciente recibe una respuesta equivocada sin que el sistema note nada raro.
Es un sesgo silencioso dentro de un control diseñado para atrapar sesgo, y
solo aparece con audio real de un ASR real — ningún doble ni ninguna prueba
de texto puede producir esta falla.

### 5.3. Cómo verificarlo con audio real

1. Con un hablante de un segmento con WER esperado alto (sección 2), grabar
   una llamada real donde se repita **dos veces seguidas** una frase poco
   clara (frase 9 del guion de captura).
2. Confirmar en la transcripción y en el audio que, tras el segundo fallo
   **consecutivo**, el agente ofrece —sin que el paciente lo pida— continuar
   por WhatsApp o pasar a una persona, y que nunca intenta una tercera vez.
3. Confirmar que un turno bien entendido en medio de dos fallos **reinicia**
   el contador (no debe acumular fallos no consecutivos).
4. Repetir el mismo guion con un ASR real deliberadamente forzado a
   confusión (ruido de fondo fuerte, solapamiento de voz) y verificar
   manualmente, escuchando el audio contra la transcripción, si aparece el
   caso de la sección 5.2: una respuesta segura del modelo a una
   transcripción incorrecta que nunca disparó el contador. Si aparece,
   **no es un defecto de esta fase**: es exactamente el tipo de hallazgo que
   la Fase 3 del modelo de auditoría (monitoreo posdespliegue, muestreo
   aleatorio escuchando audio y no solo leyendo transcripción) está diseñada
   para capturar de forma continua.
5. **Vacío detectado, no implementado en esta rama:** el control C5 del
   informe ético menciona *"alternativa por tonos del teclado (DTMF) para
   confirmar fecha y hora"*. No existe ninguna implementación de DTMF en
   `src/channels/voice` en este estado del repositorio. Verificar el flujo
   de dos fallos con audio real **no puede** ejercitar esa alternativa
   todavía porque no está construida; queda pendiente de otra fase antes de
   que el punto 3 de esta sección se pueda dar por verificado en su
   totalidad.

## 6. Por qué esta fase no se puede automatizar

Medir un sesgo de reconocimiento del habla es, por definición, comparar lo
que una persona real dijo contra lo que un sistema real transcribió. No hay
sustituto sintético que no incurra en petición de principio: para simular un
error de ASR realista sobre un acento andino habría que **ya saber** cómo
falla un ASR real con ese acento, que es exactamente el dato que la medición
busca producir. El conjunto de ejemplo que se usó para probar
`scripts/wer.ts` de punta a punta (ver el informe final de esta construcción)
demuestra que la **aritmética** del script es correcta; no demuestra nada
sobre el sesgo real del sistema, porque los errores de esos datos fueron
inventados por un generador determinista, no producidos por un ASR
enfrentado a hablantes peruanos reales.

Concretamente, esta fase exige de personas reales:

- **Reclutamiento** de al menos 5 (idealmente 15+) hablantes por cada
  segmento de la sección 2, con diversidad real de origen, edad y condición
  bucal — no aproximable por miembros del propio equipo leyendo con acento
  fingido.
- **Consentimiento informado por escrito**, firmado antes de cualquier
  grabación, usando la plantilla de `docs/plantillas/consentimiento-informado.md`
  **después de que un abogado la revise** (ver la nota de esa misma
  plantilla).
- **Grabación real** con el ASR que efectivamente se vaya a usar en
  producción (ElevenLabs/el proveedor de STT configurado), no un simulador.
- **Transcripción humana de referencia**, hecha por una persona que escuche
  el audio y escriba lo que realmente se dijo — es lo único que puede servir
  de referencia confiable; una referencia generada por el mismo sistema que
  se está auditando invalidaría la medición.
- **Una persona que ejecute `scripts/wer.ts`** contra esos pares y decida,
  con la brecha resultante delante, si el canal de voz se autoriza, se
  restringe por segmento, o se pospone. Esa decisión —igual que remarca el
  informe ético sobre el resto del proyecto— no se delega a una métrica
  sola: la métrica informa, la persona responsable (ver Tabla 9 del informe
  ético, "Responsable del sistema y de protección de datos") decide.

Nada de esto es ejecutable dentro de esta construcción, y no se ha fingido
que lo sea: la tabla de evidencia del brief para la Fase 7 (*"Tabla de WER
por segmento de hablante + consentimientos informados"*, Anexo B del informe
ético) queda, hasta que exista esa captura real, como **espacio de evidencia
señalizado**, no como un resultado fabricado.
