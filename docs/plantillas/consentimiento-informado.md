# Plantilla de consentimiento informado — captura de voz para la auditoría de equidad (Fase 7)

> ## ⚠ NOTA LEGAL OBLIGATORIA — LEER ANTES DE USAR ESTA PLANTILLA
>
> **Esta plantilla NO ha sido revisada por un abogado y NO debe entregarse a
> ningún participante ni usarse para recolectar una sola grabación hasta que
> un abogado especializado en protección de datos la revise y apruebe.**
> Recepción-IA no es un despacho legal y este documento no constituye
> asesoría legal. Es exactamente el control **O9** del informe
> ético-regulatorio: *"Revisión de los instrumentos contractuales y del aviso
> de privacidad por abogado especializado antes del primer cliente"* —
> extendido aquí a la captura de voz para esta auditoría, porque implica
> tratar dato biométrico (la voz) y, potencialmente, dato de salud
> (autorreporte de prótesis dental o patología bucal) de personas que no son
> pacientes de ninguna clínica todavía.
>
> Puntos que un abogado debe confirmar antes de usar esto en producción:
> texto exacto exigido por la ANPD para consentimiento de datos sensibles,
> si hace falta un formulario separado por cada finalidad (captura de voz
> distinta de la atención clínica), el plazo de conservación real que la
> organización puede sostener operativamente, y si el subencargo al
> proveedor de reconocimiento de voz (sección 5) requiere una cláusula
> contractual adicional con ese proveedor antes de esta captura.

---

## Qué es este documento

Consentimiento para participar en la **auditoría de equidad del
reconocimiento del habla** del sistema Recepción-IA (Fase 7, control C5 del
informe ético-regulatorio; protocolo completo en
`docs/fase7-equidad.md`). Se usa **antes de desplegar el canal de voz** para
medir si el sistema entiende igual de bien a distintas variedades del
castellano hablado en el Perú. **No es** un consentimiento para recibir
atención odontológica ni de ningún otro tipo, y la participación **no crea
ninguna relación de paciente** con ninguna clínica.

Marco legal de referencia: Ley N.° 29733, Ley de Protección de Datos
Personales, y su Reglamento (Decreto Supremo N.° 016-2024-JUS), que incluyen
los datos biométricos y de salud entre los datos sensibles y exigen
consentimiento previo, libre, expreso, informado e inequívoco, constando por
escrito, para su tratamiento.

---

## 1. Datos del responsable

| Campo | Valor |
|---|---|
| Responsable del tratamiento | [RECEPCIÓN-IA / RAZÓN SOCIAL] |
| Responsable de protección de datos (control O4 del informe ético) | [NOMBRE Y CANAL DE CONTACTO] |
| Finalidad de este documento | Recolectar y tratar una grabación de voz y datos demográficos mínimos, exclusivamente para medir la tasa de error de reconocimiento del habla por segmento de hablante, antes de decidir si el canal de voz del sistema Recepción-IA se despliega. |

## 2. Qué se graba y qué otros datos se piden

- **Audio de voz** leyendo o diciendo con sus propias palabras un guion de
  frases breves (el guion completo está en `docs/fase7-equidad.md`, sección
  3.2): un saludo, su nombre, una fecha y hora, una confirmación, una queja
  breve, una frase con un síntoma común, una petición de hablar con una
  persona, y una frase larga libre sobre un motivo de llamada ficticio.
  **No se le pide relatar un problema de salud real**; si lo hace de forma
  espontánea, ese fragmento se trata como dato sensible con el mismo cuidado
  que el resto del audio.
- **Datos demográficos mínimos, autorreportados y voluntarios**, usados
  únicamente para clasificar su grabación en un segmento de comparación (ver
  `docs/fase7-equidad.md`, sección 2): rango de edad, variedad dialectal o
  región de origen con la que se identifica, si el castellano es su primera
  lengua o si aprendió primero quechua, aimara u otra lengua, y si usa
  prótesis dental o tiene alguna condición bucal que quiera mencionar. **Cada
  uno de estos datos es opcional**: puede participar sin responder alguno o
  ninguno, y eso no afecta su participación.
- **Un identificador de participante** (por ejemplo "h07"), **nunca su
  nombre real**, es lo que se asocia a la grabación y a los resultados del
  análisis. La lista que vincula su identificador con su nombre real y sus
  datos de contacto se guarda por separado, con acceso restringido, y solo
  para poder atender sus derechos (sección 6) o, si usted lo autoriza
  expresamente abajo, para contactarlo con los resultados.

## 3. Para qué se usa exactamente

Exclusivamente para calcular, con `scripts/wer.ts`, la tasa de error de
palabra de su grabación frente a una transcripción humana de lo que usted
dijo, agregada junto con la de otros participantes de su mismo segmento. El
resultado agregado (nunca su grabación individual) puede incluirse como
evidencia en el informe ético-regulatorio del proyecto (Anexo B) para
documentar si el canal de voz cumple el criterio de equidad antes de
desplegarse. **No se usa** para entrenar ningún modelo propio, ni para
tomar ninguna decisión sobre usted como persona.

## 4. Cuánto tiempo se conserva

| Dato | Plazo propuesto | Después del plazo |
|---|---|---|
| Audio de la grabación | [PLAZO A DEFINIR — propuesta: 90 días desde la captura, tiempo suficiente para completar el análisis y una verificación posterior] | Se elimina de forma irreversible. |
| Transcripción de referencia | Igual que el audio, o hasta el cierre del análisis de esta fase, lo que ocurra primero | Se elimina, salvo que forme parte agregada y anonimizada de la tabla de resultados. |
| Identificador de participante en los resultados agregados | Mientras el informe ético-regulatorio del proyecto esté vigente como documento de sustento | El identificador no permite, por sí solo, reidentificar a la persona sin la lista de vinculación de la sección 2, que se elimina en el mismo plazo que el audio. |
| Datos de contacto (nombre real, teléfono/correo) | Solo mientras dure la campaña de reclutamiento y captura | Se eliminan al cerrar la captura de su segmento, salvo que usted autorice expresamente ser contactado con los resultados. |

**[ESTE CUADRO ES UNA PROPUESTA DE PARTIDA, NO UN PLAZO YA VALIDADO.]** El
plazo real debe fijarse con capacidad operativa de sostenerlo y confirmarse
en la revisión legal (nota superior).

## 5. Con quién se comparte

- **Equipo interno de Recepción-IA**, con acceso limitado a quienes ejecutan
  el análisis de esta fase.
- **El proveedor de reconocimiento de voz (ASR/STT)** que efectivamente se
  esté evaluando (por ejemplo, el motor que usa la plataforma de voz del
  sistema), porque es precisamente su transcripción automática la que se
  audita. Si ese proveedor es un servicio de terceros, su audio se procesa
  bajo los términos de ese proveedor, que pueden incluir el uso de la
  conversación para mejorar sus propios servicios — esto debe verificarse y
  configurarse para minimizarlo (ver `docs/contrato-elevenlabs.md`) **antes**
  de correr esta captura con un proveedor real, y debe explicarse aquí en
  lenguaje llano cuál es la política vigente del proveedor concreto que se
  vaya a usar, sin asumir que "no comparte con nadie" si el contrato del
  proveedor dice otra cosa.
- **No se comparte** con ninguna clínica cliente de Recepción-IA, ni se
  vende, cede o transfiere a nadie más fuera de lo descrito arriba.
- Si en algún momento se planea compartir con alguien no listado aquí, se le
  debe pedir un consentimiento nuevo y específico para eso: este documento
  no autoriza usos futuros no descritos.

## 6. Sus derechos, y cómo ejercerlos

Conforme a la Ley N.° 29733 y su Reglamento, usted tiene derecho a:

- **Acceso**: saber qué datos suyos se conservan y para qué.
- **Rectificación**: corregir un dato suyo que esté equivocado.
- **Supresión**: pedir que se elimine su grabación y sus datos, antes de que
  venza el plazo de la sección 4.
- **Oposición**: retirar su consentimiento y oponerse a que se siga
  tratando su información, en cualquier momento.
- Información completa sobre el tratamiento (este mismo documento es parte
  de esa obligación) y a no recibir un trato automatizado sin poder
  cuestionarlo.

**Cómo ejercerlos:** escribiendo a [CANAL DE CONTACTO DEL RESPONSABLE DE
PROTECCIÓN DE DATOS], indicando su identificador de participante si lo
conserva. Se le debe responder dentro de un plazo razonable, que la revisión
legal debe fijar de forma explícita (la Ley N.° 29733 no deja este plazo a
criterio de cada organización sin más).

## 7. Participación voluntaria y revocable

- Participar es **completamente voluntario**. No participar, o dejar de
  participar a mitad de la grabación, no tiene ninguna consecuencia para
  usted ni le niega ningún servicio.
- Puede **retirar su consentimiento en cualquier momento**, incluso después
  de grabar, sin necesidad de justificar por qué. Al retirarlo, su
  grabación y sus datos de contacto se eliminan (sección 4), salvo que ya
  formen parte de un resultado agregado y anonimizado que para ese momento
  no permita identificarlo individualmente.
- Puede negarse a responder cualquiera de los datos demográficos
  opcionales de la sección 2 sin que eso afecte su participación en lo
  demás.

## 8. Advertencia sobre menores de edad

**Esta plantilla es exclusivamente para personas mayores de edad.** Si se
necesita capturar la voz de un menor (por ejemplo, para representar el
segmento de hablantes jóvenes), hace falta un procedimiento distinto con
consentimiento del padre, madre o apoderado, que esta plantilla no cubre. El
informe ético-regulatorio del proyecto, en sus recomendaciones, plantea
directamente excluir a menores del canal de voz por esta misma razón; antes
de capturar voz de un menor para esta auditoría, consultar con el revisor
legal si corresponde hacerlo en absoluto.

---

## 9. Declaración y firma

Yo, ______________________________________ (nombre completo), identificado
con documento N.° ______________________, declaro que:

- He leído y entendido este documento en su totalidad.
- Se me ha explicado verbalmente su contenido y he podido hacer preguntas.
- Entiendo que mi participación es voluntaria y revocable en cualquier
  momento, sin consecuencia alguna.
- Autorizo la grabación de mi voz y el tratamiento de los datos que decida
  compartir, exclusivamente para la finalidad descrita en la sección 3.

Autorizaciones específicas (marcar lo que corresponda):

- [ ] Autorizo ser contactado con los resultados agregados de esta auditoría.
- [ ] Autorizo compartir mis datos demográficos autorreportados (sección 2).
- [ ] Autorizo compartir si uso prótesis dental o tengo alguna condición
      bucal relevante para este estudio.

Firma del participante: _______________________  Fecha: ______________

Firma de quien recoge el consentimiento: _______________________

---

*Plantilla elaborada como parte de la Fase 7 del proyecto Recepción-IA.
Recuerde: no usar sin revisión legal previa (ver nota al inicio).*
