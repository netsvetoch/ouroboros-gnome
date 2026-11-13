/** Минимальные node-объявления чтобы не тянуть @types/node в сборку. */
interface ImportMeta { readonly url: string }

declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exitCode?: number;
};

declare function fetch(
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

declare function setTimeout(
  handler: (...args: any[]) => void,
  timeout?: number,
  ...args: any[]
): any;
declare function clearTimeout(handle: any): void;

declare const console: {
  log(...a: any[]): void;
  error(...a: any[]): void;
  warn(...a: any[]): void;
};

declare class URLSearchParams {
  constructor(
    init?: Record<string, string> | string[][] | string,
  );
  toString(): string;
}

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean });
  decode(input?: any): string;
}

declare class WebSocket {
  static readonly OPEN: number;
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  constructor(url: string);
  send(data: string): void;
  close(): void;
}
