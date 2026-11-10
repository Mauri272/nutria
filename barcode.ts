export type BarcodeFormat = 'EAN-13' | 'EAN-8' | 'UPC-A';

export interface NormalizedBarcode {
  /** Código tal como lo indexa Open Food Facts: un UPC-A de 12 dígitos se consulta como EAN-13 con un 0 inicial. */
  code: string;
  /** Formato del código ORIGINAL escaneado. */
  format: BarcodeFormat;
}

/** Dígito verificador GTIN (EAN-8, UPC-A, EAN-13): pesos 3,1,3,1… desde el dígito contiguo al verificador. */
export function gtinCheckDigit(digitsWithoutCheck: string): number {
  let sum = 0;
  const n = digitsWithoutCheck.length;
  for (let i = 0; i < n; i++) {
    const digit = digitsWithoutCheck.charCodeAt(n - 1 - i) - 48;
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Valida y normaliza lo que entrega el escáner o el teclado. Devuelve null si no es un código minorista válido.
 * Se ignoran espacios y guiones. No se soporta UPC-E (comprimido) ni GTIN-14 (cajas): restringe el escáner
 * a ean13 / ean8 / upc_a.
 */
export function normalizeBarcode(input: string): NormalizedBarcode | null {
  const digits = input.replace(/[\s-]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length !== 8 && digits.length !== 12 && digits.length !== 13) return null;

  const expected = gtinCheckDigit(digits.slice(0, -1));
  const actual = digits.charCodeAt(digits.length - 1) - 48;
  if (expected !== actual) return null;

  if (digits.length === 12) return { code: `0${digits}`, format: 'UPC-A' };
  return { code: digits, format: digits.length === 8 ? 'EAN-8' : 'EAN-13' };
}
