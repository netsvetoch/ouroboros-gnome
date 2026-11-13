import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const base=ARGV[0]??Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_child('dist-gjs').get_child('gjs').get_uri()+'/';
const {NativeFormula}=await import(base+'math-view.js');
const {texMathML,mathParserVersion}=await import(base+'vendor/math-engine.js');
const {renderMathSvg}=await import(base+'math-svg.js');
const {markdownView}=await import(base+'markdown-view.js');
const {canvasGraphics,svgRenderer}=await import(base+'gi.js');
const check=(ok,why)=>{if(!ok)throw new Error(why)};
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
function all(w,p){let out=p(w)?[w]:[];for(let c=w.get_first_child();c;c=c.get_next_sibling())out.push(...all(c,p));return out}
const output=GLib.dir_make_tmp('ouroboros-native-math-XXXXXX');
const app=new Adw.Application({flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:850,default_height:700});win.present();const style=Adw.StyleManager.get_default(),original=style.get_color_scheme();
 (async()=>{
  const {Cairo}=canvasGraphics(),Rsvg=svgRenderer();
  const samples=[String.raw`\frac{a+b}{c}`,String.raw`\int_0^\infty e^{-x^2}\,dx=\frac{\sqrt{\pi}}{2}`,String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`,String.raw`\begin{cases}x^2&x>0\\-x&x\le 0\end{cases}`,String.raw`\mathrm{2H_2+O_2\to2H_2O}`,String.raw`\widehat{ABC}+\sqrt[3]{x}`,String.raw`\text{Пример: }\alpha^2`,String.raw`\newcommand{\foo}{x^2}\foo`];
  for(const [index,source] of samples.entries()){
   const math=renderMathSvg(source,true,20);const surface=new Cairo.ImageSurface(Cairo.Format.ARGB32,math.width,math.height),context=new Cairo.Context(surface);
   const path=output+'/'+index+'.png',blank=output+'/'+index+'-blank.png';surface.writeToPNG(blank);
   Rsvg.Handle.new_from_data(new TextEncoder().encode(math.svg)).render_document(context,new Rsvg.Rectangle({x:0,y:0,width:math.width,height:math.height}));surface.writeToPNG(path);
   const [,actual]=Gio.File.new_for_path(path).load_contents(null),[,empty]=Gio.File.new_for_path(blank).load_contents(null);
   check(actual.length!==empty.length||actual.some((v,i)=>v!==empty[i]),'formula painted no pixels: '+source);
   context.$dispose();surface.finish();
  }
  const corpusPath=ARGV[1]??Gio.File.new_for_uri(import.meta.url).get_parent().get_child('fixtures').get_child('katex-gateway-0.17.json').get_path();
  const [,corpusBytes]=Gio.File.new_for_path(corpusPath).load_contents(null),corpus=JSON.parse(new TextDecoder().decode(corpusBytes));check(mathParserVersion===corpus.version,'gateway parser version mismatch');
  for(const group of corpus.groups){let macros={};for(const item of group.expressions){if(group.reset)macros={};let value,error;try{value=texMathML(item.source,item.display,macros)}catch(e){error=e.rawMessage??e.message}check(item.error?error===item.error:value===item.mathml,'gateway parser conformance: '+item.source)}}
  for(const source of [String.raw`\rule{2em}{1em}`,String.raw`\rule[1em]{2em}{1em}`,String.raw`\raisebox{1em}{x}`,String.raw`\smash{\frac ab}`,String.raw`\mathllap{x}+y`]){
   const native=new NativeFormula(source,false,20),shape=native.area.geometry;check(shape.width>0&&shape.height>10,'overhanging formula clipped: '+source);
   const surface=new Cairo.ImageSurface(Cairo.Format.ARGB32,shape.width,shape.height),cr=new Cairo.Context(surface),path=output+'/overhang-'+GLib.uuid_string_random()+'.png',empty=path+'.blank';surface.writeToPNG(empty);Rsvg.Handle.new_from_data(new TextEncoder().encode(shape.svg)).render_document(cr,new Rsvg.Rectangle({x:0,y:0,width:shape.width,height:shape.height}));surface.writeToPNG(path);const [,a]=Gio.File.new_for_path(path).load_contents(null),[,b]=Gio.File.new_for_path(empty).load_contents(null);check(a.length!==b.length||a.some((v,i)=>v!==b[i]),'overhang drew no ink: '+source);cr.$dispose();surface.finish();
  }
  const formula=new NativeFormula(String.raw`\frac{x^2}{y}`,true);win.set_content(formula.widget);await wait(100);
  check(formula.handle&&formula.theme,'formula did not attach native renderer/theme handler');
  const before=formula.handle;style.set_color_scheme(Adw.ColorScheme.FORCE_DARK);await wait(30);style.set_color_scheme(Adw.ColorScheme.FORCE_LIGHT);await wait(30);check(formula.handle!==before,'theme did not refresh native math');
  const popover=formula.widget.get_popover(),copy=all(popover.get_child(),w=>w instanceof Gtk.Button&&w.label==='Скопировать TeX')[0];copy.emit('clicked');
  const copied=await new Promise((resolve,reject)=>formula.widget.get_clipboard().read_text_async(null,(clipboard,result)=>{try{resolve(clipboard.read_text_finish(result))}catch(e){reject(e)}}));check(copied===formula.source,'formula copy changed TeX');
  win.set_content(new Gtk.Label());await wait(30);check(!formula.handle&&!formula.theme,'unmap retained formula renderer or theme signal');win.set_content(formula.widget);await wait(30);check(formula.handle&&formula.theme,'formula did not restore on remap');
  let linked='';
  const source=String.raw`# Формулы

Текст **с выделением** и \(a^2+b^2=c^2\), затем [ссылка](https://example.org/path).

$$\frac{\sum_{k=1}^{n} k}{n}=\frac{n+1}{2}$$

> Вложенная \(\sqrt{x}\) и \`\(буквальный код\)\`.

| Величина | Значение |
| --- | --- |
| Доля | \(\frac{a}{b}\) |

Ошибка \(\doesNotExist\), затем нормальный текст.

\`\`\`tex
\(код без отрисовки\)
\`\`\``.replaceAll('\\`','`');
  const view=markdownView(source,undefined,{chat:true,onLink:href=>{linked=href;return true}});win.set_content(new Gtk.ScrolledWindow({child:view}));await wait(150);
  check(all(view,w=>w instanceof Gtk.MenuButton&&w.has_css_class('math-formula')).length===4,'inline/display/nested/table math not mounted, or code became math');
  const prose=all(view,w=>w instanceof Gtk.TextView&&w.has_css_class('markdown-math'));
  check(prose.length===5,'formula paragraphs missing');
  check(prose.some(w=>{const b=w.get_buffer();return b.get_text(b.get_start_iter(),b.get_end_iter(),false).includes(String.raw`\(\doesNotExist\)`) }),'invalid formula lost its source');
  const first=prose[0],b=first.get_buffer(),flat=b.get_slice(b.get_start_iter(),b.get_end_iter(),true),offset=flat.indexOf('ссылка');check(offset>=0,'link text missing');
  const mark=b.get_iter_at_offset(offset+1),rect=first.get_iter_location(mark),[x,y]=first.buffer_to_window_coords(Gtk.TextWindowType.WIDGET,rect.x+2,rect.y+Math.max(1,rect.height/2));
  const controllers=first.observe_controllers();let click;for(let i=0;i<controllers.get_n_items();i++){const controller=controllers.get_item(i);if(controller.get_name()==='markdown-math-links')click=controller}
  check(click,'math paragraph lost link controller');click.emit('released',1,x,y);check(linked==='https://example.org/path','native math paragraph link did not dispatch');
  if(GLib.getenv('MATH_SCREENSHOT'))Gio.Subprocess.new(['import','-window','root',GLib.getenv('MATH_SCREENSHOT')],Gio.SubprocessFlags.NONE).wait_check(null);
  win.set_default_size(420,650);await wait(100);check(first.get_width()<700,'math paragraph did not adapt to narrow window');
  const macroSource=String.raw`\(\gdef\shared{x}\shared\)

\(\shared\)

\(\gdef\shared{y}\shared\)

\(\shared\)`;
  const macroView=markdownView(macroSource,undefined,{chat:true});win.set_content(macroView);await wait(50);check(all(macroView,w=>w instanceof Gtk.MenuButton&&w.has_css_class('math-formula')).length===4,'global definitions did not cross paragraphs');
  const isolated=markdownView(String.raw`\(\shared\)`,undefined,{chat:true});check(!all(isolated,w=>w instanceof Gtk.MenuButton&&w.has_css_class('math-formula')).length,'macros leaked between messages');
  const tableSource='| Formula |\n| --- |\n'+Array.from({length:51},(_,i)=>'| '+(i===50?String.raw`\(\gdef\fromtable{z}\fromtable\)`:'row'+i)+' |').join('\n')+'\n\n'+String.raw`After \(\fromtable\)`;
  const tableView=markdownView(tableSource,undefined,{chat:true});win.set_content(new Gtk.ScrolledWindow({child:tableView}));await wait(50);check(all(tableView,w=>w instanceof Gtk.MenuButton&&w.has_css_class('math-formula')).length===1,'macro from an unshown table page not evaluated');
  const next=all(tableView,w=>w instanceof Gtk.Button&&w.label==='Следующие строки')[0];next.emit('clicked');await wait(20);check(all(tableView,w=>w instanceof Gtk.MenuButton&&w.has_css_class('math-formula')).length===2,'table page did not reuse prepared formulas');
  const ordinary=markdownView(String.raw`\(plain component Markdown\)`);check(!all(ordinary,w=>w instanceof Gtk.MenuButton&&w.has_css_class('math-formula')).length,'math enabled outside the gateway chat contract');
  win.set_content(new Gtk.Label());await wait(30);check(!formula.handle&&!formula.theme,'replaced formula retained resources');
  print('OK: KaTeX 0.17 gateway conformance (54 cases), document macro scope/lazy pages and overhang geometry; native MathML/SVG/librsvg pixels for fractions/integrals/matrices/cases/chemistry/accents/Cyrillic/macros; inline/display/nested/table GTK math, literal code/error fallback, exact TeX clipboard, link dispatch, narrow layout, theme and unmap/remap cleanup; images '+output);
 })().catch(error=>{failed=true;logError(error)}).finally(()=>{win.close();style.set_color_scheme(original);app.quit()});
});await app.runAsync([]);exit(failed?1:0);
