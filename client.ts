import { normalizeBarcode } from './barcode';
import { OffError } from './errors';
import { parseProductResponse, parseSearchResponse, type OffLookupResult, type OffProduct } from './mapper';

/** Subconjunto estructural de `Response`: el `fetch` global (React Native, Node, navegador) lo satisface. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal },
) => Promise<FetchResponseLike>;

export interface OffClientConfig {
  /** Nombre de TU app en el User-Agent, p. ej. "NutriApp". */
  appName: string;
  appVersion: string;
  /**
   * Contacto de TU proyecto (email o URL). Open Food Facts exige un User-Agent identificable
   * (`NombreApp/versión (contacto)`) para poder avisarte si tu tráfico causa problemas.
   * Sin valor por defecto a propósito: configúralo en un solo lugar (src/config).
   */
  contact: string;
  /**
   * Enviar el User-Agent identificable (por defecto true). En NAVEGADORES poner false: no pueden fijar ese
   * encabezado, y un encabezado no estándar dispararía un preflight CORS. Con false, appName/contact no se validan.
   */
  sendUserAgent?: boolean | undefined;
  baseUrl?: string | undefined;
  /** Idioma preferido para el nombre del producto (campo product_name_<xx>). Por defecto "es". */
  language?: string | undefined;
  fetch?: FetchLike | undefined;
  /** Plazo por intento, en ms (por defecto 8000). */
  timeoutMs?: number | undefined;
  /** Reintentos tras el primer intento, para red/timeout/429/5xx (por defecto 2). */
  maxRetries?: number | undefined;
  /** Espera base del backoff exponencial en ms (por defecto 500). */
  retryBaseDelayMs?: number | undefined;
  /** Inyectable para tests. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface LookupOptions {
  signal?: AbortSignal | undefined;
}

export interface SearchOptions extends LookupOptions {
  /** 1–50, por defecto 20. */
  pageSize?: number | undefined;
}

const DEFAULT_BASE_URL = 'https://world.openfoodfacts.org';
const MAX_BACKOFF_MS = 10_000;

interface HttpOutcome {
  status: number;
  ok: boolean;
  retryAfterMs: number | null;
  body: unknown;
}

export class OpenFoodFactsClient {
  readonly userAgent: string | null;
  private readonly baseUrl: string;
  private readonly language: string;
  private readonly fields: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(config: OffClientConfig) {
    const sendUa = config.sendUserAgent ?? true;
    const identity: ReadonlyArray<readonly [string, string]> = sendUa
      ? [
          ['appName', config.appName],
          ['appVersion', config.appVersion],
          ['contact', config.contact],
        ]
      : [];
    for (const [key, value] of identity) {
      if (value.trim() === '' || !/^[\x20-\x7E]+$/.test(value)) {
        throw new OffError('CONFIG', `${key} es obligatorio y debe ser ASCII imprimible (el User-Agent identifica tu app).`);
      }
    }
    const language = config.language ?? 'es';
    if (!/^[a-z]{2,3}$/.test(language)) {
      throw new OffError('CONFIG', `language debe ser un código de 2–3 letras minúsculas (recibido: "${language}").`);
    }

    this.userAgent = sendUa ? `${config.appName}/${config.appVersion} (${config.contact})` : null;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.language = language;
    this.fields = [
      'code',
      'product_name',
      `product_name_${language}`,
      'generic_name',
      'brands',
      'quantity',
      'serving_size',
      'serving_quantity',
      'nutriments',
    ].join(',');
    // Envoltorio (no `fetch` suelto): en navegadores, llamar fetch como método de otro objeto lanza "Illegal invocation".
    this.fetchFn = config.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.timeoutMs = config.timeoutMs ?? 8000;
    this.maxRetries = config.maxRetries ?? 2;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? 500;
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Busca un producto por código de barras (EAN-13 / EAN-8 / UPC-A, con dígito verificador válido).
   *  - Encontrado → { status: 'found', product } (valores por 100 g).
   *  - No existe en OFF → { status: 'not_found' }: la UI ofrece creación manual y la guarda en SQLite.
   *  - Problemas de red/servidor → lanza OffError (la UI debe distinguirlo de "no existe").
   */
  async getProductByBarcode(input: string, options: LookupOptions = {}): Promise<OffLookupResult> {
    const barcode = normalizeBarcode(input);
    if (barcode === null) {
      throw new OffError('INVALID_BARCODE', `Código de barras inválido: "${input}".`);
    }
    const url = `${this.baseUrl}/api/v2/product/${barcode.code}.json?fields=${encodeURIComponent(this.fields)}`;
    const outcome = await this.requestWithRetries(url, options.signal, 404);
    if (outcome === 'not_found') return { status: 'not_found', barcode: barcode.code };
    return parseProductResponse(outcome, barcode.code, this.language);
  }

  /**
   * Búsqueda por texto (endpoint clásico cgi/search.pl; OFF limita las búsquedas a ~10/min por IP: la UI debe
   * lanzarla solo al enviar, nunca por tecla). Devuelve productos ya mapeados (pueden estar incompletos).
   */
  async searchProducts(query: string, options: SearchOptions = {}): Promise<OffProduct[]> {
    const q = query.trim();
    if (q.length < 2) throw new OffError('BAD_RESPONSE', 'Escribe al menos 2 caracteres para buscar.');
    const pageSize = Math.min(50, Math.max(1, Math.trunc(options.pageSize ?? 20)));
    const url =
      `${this.baseUrl}/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1` +
      `&page_size=${pageSize}&fields=${encodeURIComponent(this.fields)}`;
    const body = await this.requestWithRetries(url, options.signal, null);
    if (body === 'not_found') return [];
    return parseSearchResponse(body, this.language);
  }

  /** Bucle común de reintentos. Devuelve el cuerpo JSON, o 'not_found' si el HTTP coincide con `notFoundStatus`. */
  private async requestWithRetries(
    url: string,
    signal: AbortSignal | undefined,
    notFoundStatus: number | null,
  ): Promise<unknown> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const isLast = attempt === this.maxRetries;
      let outcome: HttpOutcome;
      try {
        outcome = await this.requestOnce(url, signal);
      } catch (err) {
        if (!(err instanceof OffError)) throw err;
        if (err.code === 'ABORTED' || err.code === 'BAD_RESPONSE' || isLast) throw err;
        await this.sleep(this.backoffMs(attempt, null));
        continue;
      }

      if (outcome.ok) return outcome.body;
      if (notFoundStatus !== null && outcome.status === notFoundStatus) return 'not_found';

      const retryable = outcome.status === 429 || outcome.status >= 500;
      if (!retryable) {
        throw new OffError('BAD_RESPONSE', `Open Food Facts respondió HTTP ${outcome.status}.`, outcome.status);
      }
      if (isLast) {
        throw new OffError(
          outcome.status === 429 ? 'RATE_LIMITED' : 'SERVER',
          `Open Food Facts respondió HTTP ${outcome.status} tras ${attempt + 1} intentos.`,
          outcome.status,
        );
      }
      await this.sleep(this.backoffMs(attempt, outcome.retryAfterMs));
    }
    throw new OffError('NETWORK', 'Sin respuesta de Open Food Facts.'); // inalcanzable; satisface al compilador
  }

  private backoffMs(attempt: number, retryAfterMs: number | null): number {
    const exponential = this.retryBaseDelayMs * 2 ** attempt;
    return Math.min(MAX_BACKOFF_MS, retryAfterMs ?? exponential);
  }

  /** Un intento HTTP. El plazo cubre también la lectura del cuerpo. */
  private async requestOnce(url: string, external: AbortSignal | undefined): Promise<HttpOutcome> {
    if (external?.aborted) throw new OffError('ABORTED', 'Consulta cancelada.');

    const controller = new AbortController();
    let timedOut = false;
    const onExternalAbort = (): void => controller.abort();
    external?.addEventListener('abort', onExternalAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      const res = await this.fetchFn(url, {
        method: 'GET',
        headers: this.userAgent === null ? { Accept: 'application/json' } : { 'User-Agent': this.userAgent, Accept: 'application/json' },
        signal: controller.signal,
      });
      let body: unknown = null;
      if (res.ok) {
        try {
          body = await res.json();
        } catch {
          if (external?.aborted || timedOut) throw new Error('lectura interrumpida');
          throw new OffError('BAD_RESPONSE', 'La respuesta de Open Food Facts no es JSON válido.', res.status);
        }
      }
      return { status: res.status, ok: res.ok, retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after')), body };
    } catch (err) {
      if (err instanceof OffError) throw err;
      if (external?.aborted) throw new OffError('ABORTED', 'Consulta cancelada.');
      if (timedOut) throw new OffError('TIMEOUT', `Open Food Facts no respondió en ${this.timeoutMs} ms.`);
      throw new OffError('NETWORK', `Error de red: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    }
  }
}

/** `Retry-After` en segundos (la forma fecha-HTTP se ignora y se usa el backoff). */
function parseRetryAfterMs(header: string | null): number | null {
  if (header === null) return null;
  const seconds = Number(header.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}
