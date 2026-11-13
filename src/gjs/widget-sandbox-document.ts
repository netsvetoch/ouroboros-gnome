import { frameHostDocument, scriptJson } from "./frame-browser.js";

export interface SandboxDocument {
  kind: "module" | "route";
  capability: string;
  proof: string;
  routeBase: string;
  src?: string;
  document?: string;
}

function script(text: string): string {
  return text.replace(/<\/script/gi, "<\\/script").replaceAll("<!--", "<\\!--");
}

function attr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

const resize = `
(() => {
  const root = document.getElementById('root');
  let previous = 0;
  let pending = null;
  const schedule = () => {
    if (pending !== null) return;
    pending = requestAnimationFrame(() => {
      pending = null;
      const rect = root.getBoundingClientRect();
      const height = Math.ceil(Math.max(root.scrollHeight, rect.bottom + Math.max(0, rect.top)));
      if (height > 0 && height !== previous) {
        previous = height;
        window.__ouroWidgetReport?.({type: 'ouro-widget-resize', height});
      }
    });
  };
  const observer = new ResizeObserver(schedule);
  observer.observe(root);
  window.addEventListener('load', schedule, {once: true});
  window.__ouroWidgetOnDispose?.(() => {
    observer.disconnect();
    if (pending !== null) cancelAnimationFrame(pending);
  });
  schedule();
})();
`;

export function moduleDocument(config: { nonce: string; routeBase: string; initialTheme: string; bridge: string;
  entry: string; classicSource?: string; resourceBase: string; assetBase: string; resize: boolean }): string {
  const { nonce, routeBase, initialTheme, bridge, entry, classicSource, resourceBase, assetBase } = config;
  const policy = assetBase
    ? `default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' blob: ${assetBase}; worker-src blob:; style-src 'unsafe-inline' ${assetBase}; img-src data: blob: ${assetBase}; media-src data: blob: ${assetBase}; font-src data: blob: ${assetBase}; base-uri ${assetBase}`
    : `default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' blob: ${routeBase}module/; worker-src blob:; style-src 'unsafe-inline'; img-src data: blob: ${resourceBase}; media-src data: blob: ${resourceBase}; font-src data: blob: ${resourceBase}`;
  const bootstrap = `${bridge}\n;globalThis.ouroWidgetFrameBridge(${scriptJson({ mode: "module", nonce, routeBase, initialTheme, assetBase, resourceBase })});`;
  const base = assetBase ? `<base href="${attr(assetBase)}">` : "";
  const executable = assetBase
    ? `<script type="module" crossorigin="anonymous" src="${attr(assetBase + entry)}"></script>`
    : `<script>${script(classicSource ?? "")}</script>`;
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${attr(policy)}"><meta name="referrer" content="no-referrer">${base}</head><body><div id="root"></div><script>${script(bootstrap)}</script>${config.resize ? `<script>${resize}</script>` : ""}${executable}</body></html>`;
}

const parent = `
((config) => {
  const send = (body) => window.webkit.messageHandlers.ouroNative.postMessage(JSON.stringify({...body, capability: config.capability}));
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts allow-pointer-lock allow-downloads');
  frame.setAttribute('allow', 'autoplay; fullscreen; clipboard-write');
  frame.setAttribute('allowfullscreen', '');
  frame.referrerPolicy = 'no-referrer';
  frame.title = 'Ouroboros widget';

  let current = null;
  let sequence = 0;
  let loads = 0;
  let helloSinceLoad = false;
  const encode = async (value) => {
    if (value == null || typeof value === 'string') return value;
    const view = value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) :
      value instanceof ArrayBuffer ? new Uint8Array(value) :
      ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;
    if (!view || view.length > 32 * 1024 * 1024) throw new Error('invalid or oversized widget payload');
    let bytes = '';
    for (let offset = 0; offset < view.length; offset += 8192) bytes += String.fromCharCode(...view.subarray(offset, offset + 8192));
    return {base64: btoa(bytes)};
  };
  const retire = () => {
    if (!current) return;
    current.port.close();
    current = null;
    send({type:'host-document', document:0});
  };
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (event.source !== frame.contentWindow || msg?.type !== 'ouro-widget-hello' || event.ports.length !== 1) return;
    const routes = config.kind === 'route';
    if ((routes ? msg.lease : msg.nonce) !== config.proof || (!routes && sequence)) return;
    helloSinceLoad = true;
    retire();
    const adopted = {port:event.ports[0], document:++sequence, nonce:routes ? '' : config.proof};
    current = adopted;
    send({type:'host-document', document:adopted.document});
    adopted.port.onmessage = async (event) => {
      const msg = event.data;
      if (current !== adopted || !msg || typeof msg !== 'object' || msg.nonce !== adopted.nonce) return;
      const document = adopted.document;
      try {
        if (msg.type === 'ouro-widget-fetch') {
          const init = msg.init || {};
          const body = await encode(init.body);
          if (current === adopted) send({type:msg.type, document, id:msg.id, url:msg.url,
            init:{method:init.method,headers:init.headers,timeoutMs:init.timeoutMs,body}});
        } else if (msg.type === 'ouro-widget-download') {
          const source = await encode(msg.source);
          if (current === adopted) send({type:msg.type, document, id:msg.id, name:msg.name, source});
        } else if (msg.type === 'ouro-widget-open-external') {
          send({type:msg.type, document, id:msg.id, url:msg.url, activated:navigator.userActivation?.isActive === true});
        } else send({type:msg.type, document, id:msg.id, op:msg.op, height:msg.height,
          kind:msg.kind, message:msg.message, source:msg.source, line:msg.line});
      } catch (error) {
        if (current !== adopted) return;
        if (msg.type === 'ouro-widget-fetch') adopted.port.postMessage({type:'ouro-widget-fetch-chunk', nonce:adopted.nonce,
          id:msg.id,phase:'error',error:String(error.message)});
        if (msg.type === 'ouro-widget-download') adopted.port.postMessage({type:'ouro-widget-download-result', nonce:adopted.nonce,
          id:msg.id,result:{ok:false,error:String(error.message)}});
      }
    };
    adopted.port.postMessage({type:'ouro-widget-ready', routeBase:config.routeBase, nonce:adopted.nonce});
  });
  frame.addEventListener('load', () => {
    loads++;
    if (config.kind === 'module' && loads > 1) {
      retire();
      send({type:'host-navigated'});
    } else if (config.kind === 'route' && !helloSinceLoad) retire();
    helloSinceLoad = false;
    if (loads === 1) send({type:'host-loaded'});
  });
  Object.defineProperty(window, 'ouroNativeReceive', {value:(capability, document, payload) => {
    if (capability !== config.capability || !current || current.document !== document) return false;
    const message = {...payload, nonce:current.nonce};
    if (message.type === 'ouro-widget-fetch-chunk' && message.phase === 'data') {
      const binary = atob(message.base64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      delete message.base64;
      message.chunk = bytes.buffer;
      current.port.postMessage(message, [message.chunk]);
    } else current.port.postMessage(message);
    return true;
  }});
  if (config.kind === 'module') frame.srcdoc = config.document;
  else frame.src = config.src;
  document.body.append(frame);
})
`;

export function parentDocument(config: SandboxDocument): string {
  return frameHostDocument(parent, config);
}
