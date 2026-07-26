import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyElevenLabsWebhookSignature } from '../../src/infra/elevenlabs.client.js';

/**
 * Firma un cuerpo como lo haria el proveedor, segun la convencion que
 * asumimos (`${timestamp}.${rawBody}`, patron Stripe). Esa asuncion esta
 * declarada en docs/contrato-elevenlabs.md: el proveedor no documenta la
 * composicion exacta del string firmado.
 */
function firmar(rawBody: string, secreto: string, timestampSeg: number): string {
  const hash = createHmac('sha256', secreto).update(`${timestampSeg}.${rawBody}`).digest('hex');
  return `t=${timestampSeg},v0=${hash}`;
}

describe('verifyElevenLabsWebhookSignature', () => {
  const cuerpo = JSON.stringify({ type: 'post_call_transcription', data: {} });
  const secreto = 'secreto-de-webhook';
  const ahora = new Date('2026-07-26T12:00:00Z');
  const tsAhora = Math.floor(ahora.getTime() / 1000);

  it('acepta una firma valida dentro de la ventana', () => {
    const cabecera = firmar(cuerpo, secreto, tsAhora);
    const r = verifyElevenLabsWebhookSignature(cuerpo, cabecera, secreto, { now: () => ahora });
    expect(r.valid).toBe(true);
  });

  it('rechaza una firma calculada con otro secreto', () => {
    const cabecera = firmar(cuerpo, 'otro-secreto', tsAhora);
    const r = verifyElevenLabsWebhookSignature(cuerpo, cabecera, secreto, { now: () => ahora });
    expect(r.valid).toBe(false);
  });

  it('rechaza si el cuerpo cambio despues de firmarse', () => {
    const cabecera = firmar(cuerpo, secreto, tsAhora);
    const r = verifyElevenLabsWebhookSignature(`${cuerpo} `, cabecera, secreto, { now: () => ahora });
    expect(r.valid).toBe(false);
  });

  it('rechaza un timestamp fuera de la ventana de tolerancia (replay)', () => {
    const viejo = firmar(cuerpo, secreto, tsAhora - 3600);
    const r = verifyElevenLabsWebhookSignature(cuerpo, viejo, secreto, { now: () => ahora });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/tolerancia/);
  });

  describe('REGRESION: falla cerrado ante secreto vacio', () => {
    // createHmac('sha256', '') es un HMAC valido. Sin guarda, un despliegue que
    // olvide ELEVENLABS_WEBHOOK_SECRET aceptaria webhooks de cualquiera que
    // conociese esa condicion, y con ellos se puede cerrar llamadas y marcar
    // `disclosure_ejecutada`, que es evidencia auditable de una obligacion
    // contractual. Una verificacion que no verifica es peor que ninguna.
    it('rechaza aunque la firma sea coherente con el secreto vacio', () => {
      const cabeceraFabricada = firmar(cuerpo, '', tsAhora);
      const r = verifyElevenLabsWebhookSignature(cuerpo, cabeceraFabricada, '', {
        now: () => ahora,
      });
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/secreto de webhook vacio/);
    });

    it('el secreto vacio se rechaza ANTES de mirar el header', () => {
      const r = verifyElevenLabsWebhookSignature(cuerpo, undefined, '', { now: () => ahora });
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/secreto de webhook vacio/);
    });
  });
});
