import { frameHostDocument, scriptJson } from "./frame-browser.js";

export interface CardTheme { name: "light" | "dark"; css: string }
export const cardStateLimit = 32 * 1024;

const csp = "default-src 'none'; script-src 'unsafe-inline' blob: data:; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:";

const bridge = `
(({nonce, initialTheme, saved, maxBytes}) => {
  let theme = initialTheme;
  let state = saved === null ? null : JSON.parse(saved);
  const listeners = new Set();
  const send = (message) => window.parent.postMessage({...message, nonce}, '*');
  const themeStyle = document.getElementById('ouro-card-theme');
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (event.source !== window.parent || msg?.nonce !== nonce || msg.type !== 'ouro-card-theme' || !msg.theme) return;
    theme = msg.theme;
    document.documentElement.dataset.theme = theme.name;
    themeStyle.textContent = theme.css;
    for (const callback of [...listeners]) {
      try { callback(theme.name); } catch (error) { console.error(error); }
    }
  });
  let pending = 0;
  let last = 0;
  const measure = () => {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      const height = Math.ceil(document.documentElement.offsetHeight);
      if (height > 0 && height !== last) {
        last = height;
        send({type:'ouro-card-resize', height});
      }
    });
  };
  new ResizeObserver(measure).observe(document.documentElement);
  window.addEventListener('load', measure);
  const faults = new Set();
  const fault = (kind, value) => {
    const message = String(value ?? '').slice(0, 300);
    const key = kind + ':' + message;
    if (faults.has(key) || faults.size >= 10) return;
    faults.add(key);
    send({type:'ouro-card-error', kind, message});
  };
  window.addEventListener('error', (event) => fault('error', event.message || event.error));
  window.addEventListener('unhandledrejection', (event) => fault('rejection', event.reason));
  window.addEventListener('securitypolicyviolation', (event) => fault('csp', event.violatedDirective));
  window.OuroborosCard = Object.freeze({
    resize(value) {
      const height = Number(value);
      if (Number.isFinite(height) && height > 0) send({type:'ouro-card-resize', height:Math.ceil(height)});
    },
    state:Object.freeze({
      get value() { return state; },
      save(value) {
        const text = JSON.stringify(value === undefined ? null : value);
        if (new TextEncoder().encode(text).length > maxBytes) throw new RangeError('card state is larger than 32 KiB');
        state = JSON.parse(text);
        send({type:'ouro-card-state', state:text});
      }
    }),
    submit(value, summary = '') {
      send({type:'ouro-card-submit', value:value === undefined ? null : JSON.parse(JSON.stringify(value)), summary:String(summary ?? '')});
    },
    get theme() { return theme.name; },
    onTheme(callback) {
      if (typeof callback !== 'function') return () => {};
      listeners.add(callback);
      return () => listeners.delete(callback);
    }
  });
})
`;

const host = `
(({capability, nonce, documentText}) => {
  const send = (message) => window.webkit.messageHandlers.ouroCard.postMessage(JSON.stringify({...message, capability}));
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.referrerPolicy = 'no-referrer';
  frame.title = 'Ouroboros card';
  let loads = 0;
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (loads > 1 || event.source !== frame.contentWindow || msg?.nonce !== nonce) return;
    if (msg.type === 'ouro-card-resize') send({type:msg.type,height:msg.height});
    if (msg.type === 'ouro-card-error') send({type:msg.type,kind:msg.kind,message:msg.message});
    if (msg.type === 'ouro-card-state') send({type:msg.type,state:msg.state});
    if (msg.type === 'ouro-card-submit') {
      if (typeof msg.summary !== 'string') return;
      try {
        const serialized = JSON.stringify(msg.value);
        send({type:msg.type,value:typeof serialized === 'string' && serialized.length <= 300 ? msg.value : null,
          summary:msg.summary.replace(/\\s+/g,' ').trim().slice(0,300)});
      } catch {}
    }
  });
  frame.addEventListener('load', () => send({type:++loads === 1 ? 'card-loaded' : 'card-navigated'}));
  Object.defineProperty(window, 'ouroCardTheme', {value:(key, theme) => {
    if (key === capability && loads === 1) frame.contentWindow.postMessage({type:'ouro-card-theme',nonce,theme}, '*');
  }});
  frame.srcdoc = documentText;
  document.body.append(frame);
})
`;

export function appHostDocument(html: string, capability: string, nonce: string, theme: CardTheme, saved: string | null): string {
  const config = scriptJson({ nonce, initialTheme: theme, saved, maxBytes: cardStateLimit });
  const documentText = `<!doctype html><html data-theme="${theme.name}"><head><meta http-equiv="Content-Security-Policy" content="${csp}">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1"><style id="ouro-card-theme">${theme.css}</style>`
    + `<script>${bridge}(${config});</script></head><body>${html}</body></html>`;
  return frameHostDocument(host, { capability, nonce, documentText });
}
