/**
 * Tests para el enmascarador de PII.
 *
 * Criterio de aceptacion Fase 0:
 * "test que verifica que el logger enmascara un DNI y un telefono"
 *
 * Cubre: DNI, telefono E.164, telefono local, correo, objeto anidado, array,
 * y verifica que el objeto original NO se modifica.
 */

import { describe, it, expect } from 'vitest';
import { maskPII, maskKeys } from '../../src/infra/pii-masker.js';

describe('maskPII', () => {
  it('debe enmascarar DNI peruano de 8 digitos', () => {
    const dni = '46829175';
    const result = maskPII(dni);
    expect(result).toBe('********');
  });

  it('debe enmascarar DNI dentro de un string mas largo', () => {
    const text = 'El paciente con DNI 46829175 llego el 2024-01-15';
    const result = maskPII(text);
    expect(result).toContain('********');
    expect(result).not.toContain('46829175');
  });

  it('debe enmascarar telefono E.164 peruano +51XXXXXXXXX', () => {
    const phone = '+51987654321';
    const result = maskPII(phone);
    expect(result).toBe('+51*******21');
  });

  it('debe mostrar ultimos 2 digitos en telefono E.164', () => {
    const phone = '+51999887766';
    const result = maskPII(phone);
    expect(result).toBe('+51*******66');
    expect(result).toMatch(/^\+51\*+\d{2}$/);
  });

  it('debe enmascarar telefono local peruano de 9 digitos (9XXXXXXXX)', () => {
    const phone = '987654321';
    const result = maskPII(phone);
    expect(result).toBe('*******21');
  });

  it('debe mostrar ultimos 2 digitos en telefono local', () => {
    const phone = '999887766';
    const result = maskPII(phone);
    expect(result).toBe('*******66');
    expect(result).toMatch(/^\*+\d{2}$/);
  });

  it('debe enmascarar correo electronico', () => {
    const email = 'abner.cf@hotmail.com';
    const result = maskPII(email);
    expect(result).toBe('a****@hotmail.com');
  });

  it('debe preservar dominio en correos enmascarados', () => {
    const email = 'doctor.medico@clinica.com.pe';
    const result = maskPII(email);
    expect(result).toBe('d****@clinica.com.pe');
  });

  it('debe enmascarar numero de tarjeta', () => {
    const card = '4532015112830366';
    const result = maskPII(card);
    expect(result).toBe('************0366');
  });

  it('debe enmascarar numero de tarjeta con espacios', () => {
    const card = '4532 0151 1283 0366';
    const result = maskPII(card);
    expect(result).toContain('0366');
    expect(result).not.toContain('4532');
  });

  it('debe enmascarar objeto con DNI y telefono', () => {
    const obj = {
      paciente: 'Juan',
      dni: '46829175',
      telefono: '+51987654321',
    };
    const result = maskPII(obj) as Record<string, unknown>;
    expect(result.paciente).toBe('Juan');
    expect(result.dni).toBe('********');
    expect(result.telefono).toBe('+51*******21');
  });

  it('no debe mutar el objeto original', () => {
    const obj = {
      dni: '46829175',
      telefono: '+51987654321',
    };
    const original = JSON.stringify(obj);
    maskPII(obj);
    const afterMask = JSON.stringify(obj);
    expect(afterMask).toBe(original);
  });

  it('debe enmascarar objetos anidados', () => {
    const obj = {
      paciente: {
        nombre: 'Maria',
        dni: '87654321',
        contacto: {
          telefono: '912345678',
          email: 'maria@example.com',
        },
      },
    };
    const result = maskPII(obj) as Record<string, unknown>;
    const paciente = result.paciente as Record<string, unknown>;
    const contacto = paciente.contacto as Record<string, unknown>;
    expect(paciente.dni).toBe('********');
    expect(contacto.telefono).toBe('*******78');
    expect(contacto.email).toBe('m****@example.com');
  });

  it('debe enmascarar arrays de objetos', () => {
    const arr = [
      { dni: '46829175', nombre: 'Juan' },
      { dni: '87654321', nombre: 'Maria' },
    ];
    const result = maskPII(arr) as Array<Record<string, unknown>>;
    expect(result[0].dni).toBe('********');
    expect(result[1].dni).toBe('********');
    expect(result[0].nombre).toBe('Juan');
  });

  it('debe enmascarar arrays de strings con numeros telefonicos', () => {
    const arr = ['987654321', '+51912345678', 'nombre'];
    const result = maskPII(arr) as unknown[];
    expect(result[0]).toBe('*******21');
    expect(result[1]).toBe('+51*******78');
    expect(result[2]).toBe('nombre');
  });

  it('debe manejar null y undefined', () => {
    expect(maskPII(null)).toBe(null);
    expect(maskPII(undefined)).toBe(undefined);
  });

  it('debe manejar Date sin enmascarar', () => {
    const date = new Date('2024-01-15');
    const result = maskPII(date);
    expect(result).toBeInstanceOf(Date);
    expect(result).toEqual(date);
  });

  it('debe manejar numeros sin enmascarar', () => {
    expect(maskPII(12345)).toBe(12345);
    expect(maskPII(3.14)).toBe(3.14);
  });

  it('debe manejar booleanos sin enmascarar', () => {
    expect(maskPII(true)).toBe(true);
    expect(maskPII(false)).toBe(false);
  });

  it('debe detener referencias circulares', () => {
    const obj: Record<string, unknown> = { name: 'Juan' };
    obj.self = obj;
    const result = maskPII(obj) as Record<string, unknown>;
    expect(result.name).toBe('Juan');
    expect(result.self).toBeUndefined();
  });

  it('debe enmascarar carne de extranjeria', () => {
    const text = 'Documento CE A123456789';
    const result = maskPII(text);
    expect(result).toContain('CE');
    expect(result).not.toContain('A123456789');
  });

  it('debe enmascarar "carne de extranjeria" con esa frase literal', () => {
    const text = 'Su carne de extranjeria es ABC123DEF456';
    const result = maskPII(text);
    expect(result).not.toContain('ABC123DEF456');
  });
});

describe('maskKeys', () => {
  it('debe enmascarar campos especificos por nombre', () => {
    const obj = {
      telefono: '+51987654321',
      nombre: 'Juan',
      edad: 30,
    };
    const result = maskKeys(obj, ['telefono']) as Record<string, unknown>;
    expect(result.telefono).toBe('+51*******21');
    expect(result.nombre).toBe('Juan');
    expect(result.edad).toBe(30);
  });

  it('debe ser case-insensitive en nombres de campos', () => {
    const obj = {
      TELEFONO: '+51987654321',
      nombre: 'Juan',
    };
    const result = maskKeys(obj, ['telefono']) as Record<string, unknown>;
    expect(result.TELEFONO).toBe('+51*******21');
  });

  it('debe enmascarar multiples campos', () => {
    const obj = {
      dni: '46829175',
      email: 'juan@example.com',
      nombre: 'Juan',
    };
    const result = maskKeys(obj, ['dni', 'email']) as Record<string, unknown>;
    expect(result.dni).toBe('********');
    expect(result.email).toBe('j****@example.com');
    expect(result.nombre).toBe('Juan');
  });

  it('debe no mutar el objeto original', () => {
    const obj = {
      telefono: '+51987654321',
      nombre: 'Juan',
    };
    const original = JSON.stringify(obj);
    maskKeys(obj, ['telefono']);
    expect(JSON.stringify(obj)).toBe(original);
  });

  it('debe enmascarar en objetos anidados', () => {
    const obj = {
      paciente: {
        nombre: 'Maria',
        telefono: '912345678',
      },
    };
    const result = maskKeys(obj, ['telefono']) as Record<string, unknown>;
    const paciente = result.paciente as Record<string, unknown>;
    expect(paciente.telefono).toBe('*******78');
  });

  it('debe manejar nombres de campos que no existen', () => {
    const obj = {
      nombre: 'Juan',
    };
    const result = maskKeys(obj, ['telefono', 'dni']) as Record<string, unknown>;
    expect(result.nombre).toBe('Juan');
  });
});

describe('Integracion: logger + maskPII', () => {
  it('debe enmascarar DNI y telefono en un objeto de contexto', () => {
    const logEntry = {
      event: 'patient_contacted',
      dni: '46829175',
      telefono: '+51987654321',
      timestamp: '2024-01-15T10:30:00Z',
    };

    const masked = maskPII(logEntry) as Record<string, unknown>;
    expect(masked.dni).toBe('********');
    expect(masked.telefono).toBe('+51*******21');
    expect(masked.event).toBe('patient_contacted');
    expect(masked.timestamp).toBe('2024-01-15T10:30:00Z');
  });

  it('debe preservar estructura en objetos complejos', () => {
    const logEntry = {
      severity: 'info',
      message: 'Appointment scheduled',
      patient: {
        id: 'pat-001',
        dni: '12345678',
        phone: '987654321',
      },
      appointment: {
        date: '2024-02-01',
        time: '14:00',
      },
    };

    const masked = maskPII(logEntry) as Record<string, unknown>;
    const patient = masked.patient as Record<string, unknown>;
    const appointment = masked.appointment as Record<string, unknown>;

    expect(patient.dni).toBe('********');
    expect(patient.phone).toBe('*******21');
    expect(appointment.date).toBe('2024-02-01');
  });
});
