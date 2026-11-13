import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const base=ARGV[0]??Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_child('dist-gjs').get_child('gjs').get_uri()+'/';
const {Chart,BasicPlatform}=await import(base+'vendor/chart-engine.js');
const {CairoCanvas}=await import(base+'cairo-canvas.js');
const {NativeChart}=await import(base+'native-chart.js');
const {parseMarkdownChart,markdownChartTypes}=await import(base+'markdown-chart.js');
const {markdownChartView}=await import(base+'markdown-chart-view.js');
const check=(ok,why)=>{if(!ok)throw new Error(why)};const wait=ms=>new Promise(r=>GLib.timeout_add(0,ms,()=>{r();return GLib.SOURCE_REMOVE}));
async function until(fn,why){for(let i=0;i<150;i++){if(fn())return;await wait(20)}throw new Error(why)}
function all(w,p){let out=p(w)?[w]:[];for(let c=w.get_first_child();c;c=c.get_next_sibling())out.push(...all(c,p));return out}
const output=GLib.dir_make_tmp('ouroboros-chart-native-XXXXXX');
const app=new Adw.Application({flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:900,default_height:600});win.present();const style=Adw.StyleManager.get_default(),originalScheme=style.get_color_scheme();
 (async()=>{
  check(Chart.version==='4.4.8','engine version differs');
  const probe=new CairoCanvas(100,100);probe.context.setLineDash([2,3,4]);check(probe.context.getLineDash().join(',')==='2,3,4,2,3,4','odd dash pattern not normalized');probe.context.setLineDash([0,0]);check(probe.context.getLineDash().length===0,'zero dash should be solid');probe.context.setLineDash([-1]);check(probe.context.getLineDash().length===0,'invalid dash changed state');probe.dispose();
  for(const type of markdownChartTypes){
   const canvas=new CairoCanvas(640,360);let chart;
   try{const data=['scatter','bubble'].includes(type)?[{x:1,y:4,r:6},{x:2,y:8,r:11},{x:3,y:2,r:4}]:[1,4,3];
    chart=new Chart(canvas,{platform:BasicPlatform,type,data:{labels:['Один','Два','Три'],datasets:[{label:'Первый',data,backgroundColor:'#237cd5'},{label:'Второй',data}]},options:{responsive:false,maintainAspectRatio:false,animation:false,devicePixelRatio:type==='line'?2:1}});
    check(canvas.width===640*(type==='line'?2:1),'device pixel ratio not applied');check(chart.chartArea.width>100&&chart.chartArea.height>100,type+' chart area missing');check(chart.getDatasetMeta(0).data.length===3,type+' points missing');
    const file=output+'/'+type+'.png';canvas.context.surface.writeToPNG(file);
    const empty=new CairoCanvas(canvas.width,canvas.height),blank=output+'/'+type+'-blank.png';empty.context.surface.writeToPNG(blank);empty.dispose();
    const [,pixels]=GLib.file_get_contents(file),[,blankPixels]=GLib.file_get_contents(blank);
    check(Array.from(pixels.slice(0,8)).join(',')==='137,80,78,71,13,10,26,10',type+' did not encode PNG');
    check(pixels.length!==blankPixels.length||pixels.some((byte,index)=>byte!==blankPixels[index]),type+' painted the same surface as an empty canvas');
   }finally{chart?.destroy();canvas.dispose()}
  }
  const config=parseMarkdownChart(JSON.stringify({type:'line',data:{labels:['A','B','C'],datasets:[{label:'Alpha',data:[1,3,2],backgroundColor:'#fa1234',borderColor:'#fa1234'},{label:'Beta',data:[3,2,4]}]},options:{scales:{y:{min:0,max:10}},plugins:{title:{display:true,text:'Проверка Cairo'}}}}));
  const native=new NativeChart(config,'Нативный график');win.set_content(native.widget);await until(()=>native.chart,'GTK chart did not mount: '+native.status.label);
  check(!native.failed&&native.canvas,'chart failed');check(native.chart.scales.y.min===0&&native.chart.scales.y.max===10,'authored scales ignored');
  const first=native.chart.getDatasetMeta(0).data[0];native.event('mousemove',first.x,first.y);check(native.chart.tooltip.getActiveElements().some(x=>x.datasetIndex===0&&x.index===0),'native pointer tooltip missing');
  const hit=native.chart.legend.legendHitBoxes[0];native.event('click',hit.left+hit.width/2,hit.top+hit.height/2);check(!native.chart.isDatasetVisible(0),'native legend click did not toggle dataset');
  native.event('mouseout',-1,-1);
  const before=native.chart.options.color;style.set_color_scheme(Adw.ColorScheme.FORCE_DARK);await wait(100);const dark=native.chart.options.color;style.set_color_scheme(Adw.ColorScheme.FORCE_LIGHT);await wait(100);const light=native.chart.options.color;
  check(dark!==light,'theme did not repaint chart labels');check(native.chart.data.datasets[0].backgroundColor==='#fa1234','authored color changed');
  win.set_default_size(600,450);await wait(100);check(native.chart.width===native.area.get_width(),'chart did not resize with GTK');
  win.set_content(new Gtk.Label({label:'Hidden'}));await wait(30);check(!native.chart&&!native.canvas&&!native.signal&&!native.themeIdle,'unmapped chart retained render resources');check(Object.keys(Chart.instances).length===0,'Chart instance leaked');
  win.set_content(native.widget);await until(()=>native.chart,'chart did not remount');check(!native.chart.isDatasetVisible(0),'legend state lost on remap');
  if(GLib.getenv('CHART_SCREENSHOT')){native.event('click',native.chart.legend.legendHitBoxes[0].left+5,native.chart.legend.legendHitBoxes[0].top+5);await wait(100);Gio.Subprocess.new(['import','-window','root',GLib.getenv('CHART_SCREENSHOT')],Gio.SubprocessFlags.NONE).wait_check(null)}
  win.set_content(markdownChartView('not JSON'));check(all(win.get_content(),w=>w instanceof Gtk.Label&&w.get_text().startsWith('Не удалось')).length,'invalid source lacks fallback');const raw=all(win.get_content(),w=>w instanceof Gtk.Expander&&w.label==='Исходник графика')[0];check(raw,'invalid source lost');raw.expanded=true;check(all(raw,w=>w instanceof Gtk.TextView).some(w=>{const b=w.get_buffer();return b.get_text(b.get_start_iter(),b.get_end_iter(),false)==='not JSON'}),'fallback source changed');
  win.set_content(new Gtk.Label());await wait(20);check(Object.keys(Chart.instances).length===0,'closed chart retained registration');
  print('OK: Chart.js 4.4.8 on native Cairo/Pango, eight chart types paint pixels; native tooltip/legend, scales/options/authored color, theme/resize, remap state and resource cleanup, invalid-source fallback; images '+output);
 })().catch(error=>{failed=true;logError(error)}).finally(()=>{win.close();style.set_color_scheme(originalScheme);app.quit()});
});await app.runAsync([]);exit(failed?1:0);
