import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const base=ARGV[0]??Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_child('dist-gjs').get_child('gjs').get_uri()+'/';
const corpusPath=ARGV[1]??Gio.File.new_for_uri(import.meta.url).get_parent().get_child('fixtures').get_child('mermaid-diagrams.json').get_path();
const {mermaidRenderer,MermaidRenderer}=await import(base+'mermaid-renderer.js');
const {NativeMermaid}=await import(base+'mermaid-view.js');
const {markdownView}=await import(base+'markdown-view.js');
const {canvasGraphics,svgRenderer,webKit}=await import(base+'gi.js');
const wait=ms=>new Promise(r=>GLib.timeout_add(0,ms,()=>{r();return GLib.SOURCE_REMOVE}));
const check=(ok,why)=>{if(!ok)throw new Error(why)};
async function until(fn,why){for(let i=0;i<600;i++){if(fn())return;await wait(20)}throw new Error(why)}
function all(w,p){let out=p(w)?[w]:[];for(let c=w.get_first_child();c;c=c.get_next_sibling())out.push(...all(c,p));return out}
const click=(root,text)=>{const b=all(root,w=>w instanceof Gtk.Button&&w.label===text)[0];check(b,'missing '+text);b.emit('clicked')};
const output=GLib.dir_make_tmp('ouroboros-mermaid-native-XXXXXX');
const app=new Adw.Application({application_id:GLib.getenv('FLATPAK_ID')??'io.github.ouroboros.Client.Tests',flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:900,default_height:750});win.present();const style=Adw.StyleManager.get_default(),original=style.get_color_scheme();
 (async()=>{
  const [,bytes]=Gio.File.new_for_path(corpusPath).load_contents(null),cases=JSON.parse(new TextDecoder().decode(bytes)),types=new Set();const {Cairo}=canvasGraphics(),Rsvg=svgRenderer();
  for(const {name,source,expectedError} of cases){
   if(expectedError){let error;try{await mermaidRenderer.render(source,false,800)}catch(e){error=e.message}check(error?.includes(expectedError),name+' differs from the pinned gateway failure');continue;}
   const data=await mermaidRenderer.render(source,false,800).catch(error=>{throw new Error(name+': '+error.message)});types.add(data.diagramType);check(data.width>0&&data.height>0&&!/<foreignObject|<script|\bonload=/iu.test(data.svg),name+' lost native SVG labels');
   if(name.startsWith('html-'))check((data.svg.match(/<image\b/gu)||[]).length>=1,name+' lost its HTML image');
   if(name==='journey')check((data.svg.match(/>Start</gu)||[]).length===1,'foreignObject conversion duplicated its SVG fallback');
   check(!mermaidRenderer.view.get_parent()&&mermaidRenderer.view.get_network_session().is_ephemeral&&mermaidRenderer.view.get_context()!==webKit().WebContext.get_default(),'compiler view is mounted or shares a persistent session');
   const ratio=Math.min(1,900/data.width,900/data.height),w=Math.max(1,Math.ceil(data.width*ratio)),h=Math.max(1,Math.ceil(data.height*ratio));
   const surface=new Cairo.ImageSurface(Cairo.Format.ARGB32,w,h),cr=new Cairo.Context(surface),path=output+'/'+name+'.png',empty=path+'.blank';surface.writeToPNG(empty);
   Rsvg.Handle.new_from_data(new TextEncoder().encode(data.svg)).render_document(cr,new Rsvg.Rectangle({x:0,y:0,width:w,height:h}));surface.writeToPNG(path);
   const [,actual]=Gio.File.new_for_path(path).load_contents(null),[,blank]=Gio.File.new_for_path(empty).load_contents(null);check(actual.length!==blank.length||actual.some((v,i)=>v!==blank[i]),name+' did not paint pixels');if(name==='inline-image'||name.startsWith('html-')){const texture=Gdk.Texture.new_from_bytes(GLib.Bytes.new(actual)),downloader=Gdk.TextureDownloader.new(texture);downloader.set_format(Gdk.MemoryFormat.R8G8B8A8);const [bytes]=downloader.download_bytes(),pixels=bytes.get_data();let found=false;for(let i=0;i<pixels.length;i+=4)if(pixels[i]===128&&pixels[i+1]===144&&pixels[i+2]===160&&pixels[i+3]===255){found=true;break}check(found,'embedded raster pixels missing from native SVG');}cr.$dispose();surface.finish();
  }
  const registered=await new Promise((resolve,reject)=>mermaidRenderer.view.evaluate_javascript('JSON.stringify(mermaid.getRegisteredDiagramsMetadata())',-1,null,null,null,(view,result)=>{try{resolve(JSON.parse(view.evaluate_javascript_finish(result).to_string()).map(x=>x.id))}catch(e){reject(e)}}));
  const missing=registered.filter(id=>!['error','---','flowchart-elk','state'].includes(id)&&!types.has(id));check(!missing.length,'untested registered diagram types: '+missing.join(','));
  let parseFailed=false;try{await mermaidRenderer.render('flowchart this is invalid [',false,800)}catch{parseFailed=true}check(parseFailed,'invalid diagram accepted');
  const defended=await mermaidRenderer.render('%%{init: {"securityLevel":"loose","htmlLabels":true}}}%%\nflowchart LR\nA["<b>Literal</b>"] --> B[GTK]',false,800);check(!/<foreignObject|<script|\bonload=/iu.test(defended.svg),'directive overrode native SVG configuration');
  const cancel=new Gio.Cancellable(),pending=mermaidRenderer.render('flowchart LR\nA-->B',false,800,cancel);cancel.cancel();let cancelled=false;try{await pending}catch{cancelled=true}check(cancelled,'cancelled render completed');await mermaidRenderer.render('flowchart LR\nA-->B',false,800);
  const linkedData=await mermaidRenderer.render('sequenceDiagram\nparticipant Alice\nlink Alice: Docs @ https://example.org/docs\nAlice->>Alice: Hi',false,800);check(linkedData.links.some(x=>x.href==='https://example.org/docs'),'actor link metadata lost');
  const source='flowchart LR\nA[Клиент GNOME] --> B{Шлюз}\nB --> C[Задачи]\nB --> D[Навыки]';
  style.set_color_scheme(Adw.ColorScheme.FORCE_LIGHT);
  const native=new NativeMermaid(source);win.set_content(native.widget);await until(()=>native.handle||native.failed,'native diagram not mounted');check(!native.failed&&native.handle,'native diagram failed: '+native.status.label);
  check(!all(native.widget,w=>String(w.constructor.name).includes('WebView')).length,'browser appeared in native diagram widget');
  const before=native.scale;click(native.widget,'+');check(native.scale>before,'zoom did not change');click(native.widget,'−');click(native.widget,'По ширине');
  const first=native.data.svg;style.set_color_scheme(Adw.ColorScheme.FORCE_DARK);await until(()=>native.dark===true&&native.data.svg!==first,'diagram did not switch to dark theme');style.set_color_scheme(Adw.ColorScheme.FORCE_LIGHT);await until(()=>native.dark===false,'diagram did not switch to light theme');
  click(native.widget,'Скопировать Mermaid');const copied=await new Promise((resolve,reject)=>native.widget.get_clipboard().read_text_async(null,(clip,result)=>{try{resolve(clip.read_text_finish(result))}catch(e){reject(e)}}));check(copied===source,'Mermaid clipboard changed source');
  const target=Gio.File.new_for_path(output+'/saved.svg');Gtk.FileDialog.prototype.save=function(parent,_cancel,callback){check(parent===win,'save dialog parent is not the native window');GLib.idle_add(0,()=>{callback(this,null);return GLib.SOURCE_REMOVE})};Gtk.FileDialog.prototype.save_finish=()=>target;
  click(native.widget,'Сохранить SVG…');await until(()=>target.query_exists(null),'native SVG save failed');const [,saved]=target.load_contents(null);check(new TextDecoder().decode(saved)===native.data.svg,'export changed diagram bytes');
  if(GLib.getenv('MERMAID_SCREENSHOT')){await wait(100);Gio.Subprocess.new(['import','-window','root',GLib.getenv('MERMAID_SCREENSHOT')],Gio.SubprocessFlags.NONE).wait_check(null)}
  win.set_content(new Gtk.Label());await wait(40);check(!native.handle&&!native.theme&&!native.cancel,'unmap retained graphics/theme/render work');const cached=native.data;win.set_content(native.widget);await until(()=>native.handle,'cached diagram did not remap');check(native.data===cached,'remap rebuilt unchanged SVG');
  const bad=new NativeMermaid('flowchart [');win.set_content(bad.widget);await until(()=>bad.failed,'invalid-source fallback absent');check(bad.raw.expanded&&all(bad.raw,w=>w instanceof Gtk.TextView).length,'invalid source not readable');
  const md=markdownView('```mermaid\n'+source+'\n```',undefined,{chat:true});win.set_content(md);await until(()=>all(md,w=>w instanceof Gtk.DrawingArea).length&&!all(md,w=>w instanceof Gtk.Label&&w.label==='Построение диаграммы…'&&w.visible).length,'chat Mermaid did not mount');
  const ordinary=markdownView('```mermaid\n'+source+'\n```');check(!all(ordinary,w=>w instanceof Gtk.DrawingArea).length,'Mermaid enabled outside chat Markdown contract');
  win.set_content(new Gtk.Label());await until(()=>!mermaidRenderer.view,'idle compiler did not release its process');
  print('OK: '+cases.filter(x=>!x.expectedError).length+' Mermaid SVG cases paint native librsvg/Cairo pixels; canonical legacy failure; local ephemeral unmounted compiler, strict/directive handling, cancellation/recovery, GTK zoom/fit/theme/source clipboard/SVG export, unmap/remap cache, invalid-source fallback and idle process cleanup; images '+output);
 })().catch(e=>{failed=true;logError(e)}).finally(()=>{win.close();mermaidRenderer.close();style.set_color_scheme(original);app.quit()});
});await app.runAsync([]);exit(failed?1:0);
