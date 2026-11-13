import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const base=ARGV[0],url=ARGV[1];
const {Gateway}=await import(base+'gateway.js');
const {diagramImageLoader}=await import(base+'diagram-images.js');
const {mermaidRenderer}=await import(base+'mermaid-renderer.js');
const {NativeMermaid}=await import(base+'mermaid-view.js');
const {svgRenderer,canvasGraphics}=await import(base+'gi.js');
const check=(ok,why)=>{if(!ok)throw new Error(why)};
const wait=ms=>new Promise(r=>GLib.timeout_add(0,ms,()=>{r();return GLib.SOURCE_REMOVE}));
async function until(fn,why){for(let i=0;i<600;i++){if(await fn())return;await wait(20)}throw new Error(why)}
async function rejects(fn,why){let failed=false;try{await fn()}catch{failed=true}check(failed,why)}
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.Tests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:900,default_height:650});win.present();const gateway=new Gateway(url,'fixture-secret');
 (async()=>{
  await gateway.login('fixture');const load=diagramImageLoader(gateway),cancel=new Gio.Cancellable();
  const png=await load(url+'/redirect',cancel);check(png.startsWith('data:image/png;base64,'),'anonymous redirect did not normalize PNG');
  const external=url.replace('127.0.0.1','localhost');await load(external+'/png',cancel);
  for(const format of ['gif','jpg','webp']) {
   const image=await load(url+'/'+format,cancel),decoded=Gdk.Texture.new_from_bytes(GLib.Bytes.new(GLib.base64_decode(image.split(',')[1])));
   check(decoded.get_width()===3&&decoded.get_height()===2,'raster dimensions changed: '+format);
  }
  await load('/api/files/download?path=logo.png',cancel);await load('/api/tasks/task/artifacts/logo.png',cancel);
  const vector=await load(url+'/svg',cancel),texture=Gdk.Texture.new_from_bytes(GLib.Bytes.new(GLib.base64_decode(vector.split(',')[1])));check(texture.get_width()===20&&texture.get_height()===12,'SVG dimensions changed');
  const noSize='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 12"><rect width="20" height="12" fill="red"/></svg>');check((await load(noSize,cancel)).startsWith('data:image/png;base64,'),'inline SVG did not normalize');
  for(const route of ['/bad','/large','/chunk-large','/loop','/invalid-redirect','/missing'])await rejects(()=>load(url+route,cancel),'invalid/oversized source accepted: '+route);
  for(const source of ['file:///etc/passwd','https://user:secret@example.org/img.png','javascript:alert(1)'])await rejects(()=>load(source,cancel),'unsafe source accepted');
  await rejects(()=>load(external+'/api/files/download?path=logo.png',cancel),'foreign protected route got gateway credentials');
  const before=await gateway.json('GET','/audit'),count=before.filter(x=>x.path==='/png').length;
  const source='flowchart LR\nA@{ img: "'+external+'/png", label: "'+external+'/png", h: 50 } --> B@{ img: "/api/files/download?path=logo.png", label: "Gateway", h: 50 }\nC@{ img: "'+external+'/png", label: "Again", h: 50 }';
  const data=await mermaidRenderer.render(source,false,800,new Gio.Cancellable(),load);
  check((data.svg.match(/<image\b/g)||[]).length===3&&!/<image[^>]+href="https?:/u.test(data.svg),'exported SVG kept external image references');check(data.svg.replace(/<[^>]+>/gu,'').includes(external+'/png'),'image replacement changed visible label URL');
  const after=await gateway.json('GET','/audit');check(after.filter(x=>x.path==='/png').length===count+1,'duplicate URL fetched more than once in one diagram');
  check(after.filter(x=>x.path.startsWith('/api/')&&x.auth).every(x=>x.auth==='Bearer fixture-secret'&&x.cookie?.includes('ouroboros_auth=fixture-session')),'protected image lost password/session auth');
  check(after.filter(x=>!x.path.startsWith('/api/')).every(x=>!x.auth&&!x.cookie),'anonymous image/redirect leaked credentials or stored cookies');
  const htmlSource='flowchart LR\nA["<a href=\'https://example.org/logo\'><img src=\''+external+'/png\' alt=\'Native logo\' width=\'40\' height=\'20\'/></a><br/>'+external+'/png"] --> B["<img src=\'/api/files/download?path=logo.png\' width=\'40\' height=\'20\'/> Gateway"]\nC["<img src=\''+external+'/png\' width=\'40\' height=\'20\'/> Again"]';
  const html=await mermaidRenderer.render(htmlSource,false,800,new Gio.Cancellable(),load);
  check((html.svg.match(/<image\b/gu)||[]).length===3&&!/<foreignObject|<img\b/iu.test(html.svg),'HTML label images did not become native SVG');
  check(html.svg.includes('Native logo')&&html.svg.replace(/<[^>]+>/gu,'').includes(external+'/png'),'HTML image alternative/visible text was lost');
  check(html.links.some(x=>x.href==='https://example.org/logo'&&x.label==='Native logo'),'linked image did not retain its native link/alternative label');
  const htmlAudit=await gateway.json('GET','/audit');
  check(htmlAudit.filter(x=>x.path==='/png').length===count+2,'HTML duplicate source fetched more than once or browser loaded it');
  check(htmlAudit.filter(x=>!x.path.startsWith('/api/')).every(x=>!x.auth&&!x.cookie),'HTML image leaked credentials');
  const sequence='sequenceDiagram\nparticipant A as <img src=\''+external+'/png\' alt=\'Actor logo\' width=\'30\' height=\'20\'/> Actor\nparticipant B as GTK\nA->>B: Hello';
  const actor=await mermaidRenderer.render(sequence,false,800,new Gio.Cancellable(),load);
  // Sequence renders actor names as SVG text upstream; its parser strips img.
  check(actor.svg.includes('Actor')&&!/<foreignObject/iu.test(actor.svg),'sequence actor text was lost');
  check((await gateway.json('GET','/audit')).filter(x=>x.path==='/png').length===count+2,'image discarded by sequence renderer was fetched');
  const mixed='flowchart LR\nA@{ img: "'+external+'/png?tag=one&tag=two", label: "Shape", h: 40 } --> B["<img src=\''+external+'/png?tag=one&amp;tag=two\' width=\'40\' height=\'20\'/> HTML"]';
  const mixedData=await mermaidRenderer.render(mixed,false,800,new Gio.Cancellable(),load);
  check((mixedData.svg.match(/<image\b/gu)||[]).length===2,'mixed shape/HTML images were lost');
  check((await gateway.json('GET','/audit')).filter(x=>x.path.startsWith('/png?')).map(x=>x.path).join(',')==='/png?tag=one&tag=two','HTML entity decoding or shape/HTML URL deduplication changed the request');
  const vectorLabel='flowchart LR\nA["<img src=\''+noSize+'\' width=\'40\' height=\'20\'/> Vector"]';
  const vectorData=await mermaidRenderer.render(vectorLabel,false,800,new Gio.Cancellable(),load);
  check((vectorData.svg.match(/<image\b/gu)||[]).length===1&&vectorData.svg.includes('data:image/png;base64,'),'inline SVG in an HTML label was not normalized');
  const {Cairo}=canvasGraphics(),w=Math.ceil(data.width),h=Math.ceil(data.height),surface=new Cairo.ImageSurface(Cairo.Format.ARGB32,w,h),cr=new Cairo.Context(surface);svgRenderer().Handle.new_from_data(new TextEncoder().encode(data.svg)).render_document(cr,new (svgRenderer().Rectangle)({x:0,y:0,width:w,height:h}));const path=GLib.get_tmp_dir()+'/ouroboros-remote-images-'+GLib.uuid_string_random()+'.png';surface.writeToPNG(path);cr.$dispose();surface.finish();const [,contents]=Gio.File.new_for_path(path).load_contents(null),downloader=Gdk.TextureDownloader.new(Gdk.Texture.new_from_bytes(GLib.Bytes.new(contents)));downloader.set_format(Gdk.MemoryFormat.R8G8B8A8);const [pixels]=downloader.download_bytes(),raw=pixels.get_data();let present=false;for(let i=0;i<raw.length;i+=4)if(raw[i]===128&&raw[i+1]===144&&raw[i+2]===160&&raw[i+3]===255){present=true;break}check(present,'downloaded image did not paint original pixels');Gio.File.new_for_path(path).delete(null);
  const native=new NativeMermaid(htmlSource,url,undefined,load);win.set_content(native.widget);await until(()=>native.data||native.failed,'native diagram image did not load');check(!native.failed,'native image failed: '+native.status.label);
  const slowCancel=new Gio.Cancellable(),started=GLib.get_monotonic_time();const slow=load(url+'/slow',slowCancel);GLib.timeout_add(0,100,()=>{slowCancel.cancel();return GLib.SOURCE_REMOVE});await rejects(()=>slow,'slow image was not cancelled');check(GLib.get_monotonic_time()-started<2000000,'cancel waited for image body');
  const pendingCancel=new Gio.Cancellable(),pending=mermaidRenderer.render('flowchart LR\nA@{ img: "'+url+'/slow", label: "Cancel", h: 50 }',false,800,pendingCancel);await until(async()=>(await gateway.json('GET','/audit')).filter(x=>x.path==='/slow').length>=2,'diagram did not begin image read');pendingCancel.cancel();await rejects(()=>pending,'cancelled image diagram completed');
  const htmlCancel=new Gio.Cancellable(),htmlPending=mermaidRenderer.render('flowchart LR\nA["<img src=\''+url+'/slow\'/> Cancel"]',false,800,htmlCancel);
  await until(async()=>(await gateway.json('GET','/audit')).filter(x=>x.path==='/slow').length>=3,'HTML diagram did not begin image read');htmlCancel.cancel();await rejects(()=>htmlPending,'cancelled HTML diagram completed');
  await mermaidRenderer.render('flowchart LR\nA-->B',false,800);
  await rejects(()=>mermaidRenderer.render('flowchart LR\nA["<img src=\''+url+'/bad\'/><img src=\''+url+'/slow\'/> Parallel error"]',false,800),'parallel image failure was ignored');
  const cleaned=await new Promise((resolve,reject)=>mermaidRenderer.view.evaluate_javascript('JSON.stringify({pending:ouroborosAssets.size,html:Object.getOwnPropertyDescriptor(Element.prototype,"innerHTML").set.toString().includes("[native code]"),src:Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,"src").set.toString().includes("[native code]"),attribute:Element.prototype.setAttribute.toString().includes("[native code]")})',-1,null,null,null,(view,result)=>{try{resolve(JSON.parse(view.evaluate_javascript_finish(result).to_string()))}catch(error){reject(error)}}));
  check(cleaned.pending===0&&cleaned.html&&cleaned.src&&cleaned.attribute,'parallel failure retained requests or HTML hooks');
  const broken=new NativeMermaid('flowchart LR\nA["<img src=\''+url+'/bad\'/> Error"]',url,undefined,load);win.set_content(broken.widget);await until(()=>broken.failed,'invalid external image did not show source fallback');check(broken.raw.expanded,'failed image lost original source');
  await mermaidRenderer.render(htmlSource,false,800,new Gio.Cancellable(),load);
  print('OK: native anonymous HTTP/redirects, gateway image bearer+session, SVG/inline normalization, no cookie/token leakage, bounded/chunked/error reads, node/HTML URL deduplication and entities, linked HTML images/alternative text, original labels and raster pixels in self-contained SVG, GTK image mount/fallback and node/HTML read/render cancellation/recovery');
 })().catch(error=>{failed=true;logError(error)}).finally(()=>{win.close();mermaidRenderer.close();gateway.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
