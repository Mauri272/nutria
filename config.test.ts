import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOffClient } from '../src/config/offClient';
import { OffError } from '../src/services/openFoodFacts';

describe('createOffClient', () => {
  it('sin contacto configurado falla de forma explícita (no manda un User-Agent anónimo)', () => {
    assert.throws(() => createOffClient(''), (e: unknown) => e instanceof OffError && e.code === 'CONFIG');
  });

  it('con contacto arma el User-Agent NombreApp/versión (contacto)', () => {
    assert.equal(createOffClient('https://example.test/contact').userAgent, 'NutriApp/0.1.0 (https://example.test/contact)');
  });

  it('lee EXPO_PUBLIC_OFF_CONTACT del entorno cuando no se pasa argumento', () => {
    const previous = process.env.EXPO_PUBLIC_OFF_CONTACT;
    process.env.EXPO_PUBLIC_OFF_CONTACT = 'https://example.test/env';
    try {
      assert.equal(createOffClient().userAgent, 'NutriApp/0.1.0 (https://example.test/env)');
    } finally {
      if (previous === undefined) delete process.env.EXPO_PUBLIC_OFF_CONTACT;
      else process.env.EXPO_PUBLIC_OFF_CONTACT = previous;
    }
  });
});
