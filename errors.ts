export type OffErrorCode =
  | 'CONFIG' //           User-Agent / configuración inválida
  | 'INVALID_BARCODE' //  no es EAN-8, UPC-A ni EAN-13 válido (dígito verificador incluido)
  | 'ABORTED' //          el llamador canceló la consulta
  | 'TIMEOUT' //          sin respuesta dentro del plazo
  | 'NETWORK' //          sin conexión / fallo de transporte
  | 'RATE_LIMITED' //     HTTP 429 tras agotar los reintentos
  | 'SERVER' //           HTTP 5xx tras agotar los reintentos
  | 'BAD_RESPONSE'; //    HTTP inesperado o JSON que no cumple la forma esperada

export class OffError extends Error {
  readonly code: OffErrorCode;
  readonly status: number | undefined;

  constructor(code: OffErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'OffError';
    this.code = code;
    this.status = status;
  }
}
