# Protocolo de urgencias — Clínica Dental Aurora

> ⚠ **DATOS FICTICIOS DE DEMOSTRACIÓN.** No es un protocolo aprobado por un
> profesional sanitario. En una clínica real este documento es **obligatorio** y
> sin él el sistema no entra en producción (§3.1.3.A del informe del proyecto).

- **Fuente:** `protocolo_urgencia`
- **Versión:** 1

---

## Qué se considera urgencia

Se trata como urgencia, sin excepción y sin evaluar la gravedad, cualquiera de estas situaciones descritas por el paciente:

- Sangrado abundante que no se detiene.
- Traumatismo o golpe en la cara, la boca o los dientes.
- Pérdida de una pieza dental por un golpe.
- Inflamación acompañada de dificultad para respirar o para tragar.
- Fiebre asociada a dolor o inflamación en la boca.
- Dolor descrito como insoportable, o que impide dormir o comer.
- Absceso o secreción de pus.

La lista no es exhaustiva. Ante cualquier descripción que sugiera riesgo, se procede como urgencia. **El sesgo es deliberadamente hacia el falso positivo**: derivar de más es un costo operativo, derivar de menos es un daño.

## Qué hace el asistente ante una urgencia

1. **Interrumpe de inmediato el flujo comercial.** No ofrece cita, no menciona precios, no pregunta por el tratamiento de interés.
2. Indica acudir a un servicio de emergencia o al contacto de urgencia de la clínica.
3. Escala a una persona con prioridad `urgente`.
4. En el canal de voz, ejecuta la transferencia al número configurado.

El asistente **no evalúa la gravedad, no interpreta el síntoma y no tranquiliza al paciente sobre su estado**. Su única función en este flujo es derivar rápido.

## Contactos de derivación

- **Urgencias en horario de atención:** central de la clínica, anexo de urgencias.
- **Urgencias fuera de horario:** teléfono de urgencias de la sede Miraflores.
- **Emergencia médica general:** el paciente debe acudir al servicio de emergencia más cercano. Si hay dificultad para respirar o tragar, esa es la única indicación que se da.

## Qué NO es urgencia pero sí prioridad de agenda

Estas situaciones no activan el protocolo de urgencia, pero se ofrece la cita disponible más próxima:

- Pieza dental fracturada sin dolor.
- Corona, incrustación o brackets desprendidos.
- Molestia leve o sensibilidad al frío o al calor.
- Prótesis que dejó de ajustar.

## Indicación única autorizada

Ante una pieza dental que se salió completa por un golpe, la única indicación que el asistente puede dar es acudir de inmediato al servicio de urgencias y, si es posible, llevar la pieza. **Ninguna otra indicación de manejo está autorizada**: cualquier otra cosa es acto médico.
