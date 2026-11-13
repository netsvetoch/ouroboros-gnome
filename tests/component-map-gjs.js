import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const base=ARGV[0]??Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_child('dist-gjs').get_child('gjs').get_uri()+'/';
const {ComponentMap}=await import(base+'component-map.js');
const {WidgetView}=await import(base+'widget-view.js');
const wait=ms=>new Promise(r=>GLib.timeout_add(0,ms,()=>{r();return GLib.SOURCE_REMOVE}));
const check=(ok,why)=>{if(!ok)throw new Error(why)};
function all(w,p){let out=p(w)?[w]:[];for(let c=w.get_first_child();c;c=c.get_next_sibling())out.push(...all(c,p));return out}
const app=new Adw.Application({flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:950,default_height:780});let view,widget;
 (async()=>{
  const markers=Array.from({length:203},(_,i)=>({lat:55.7+i*.001,lon:37.5+i*.002,label:'Point'+i,popup:'<b>Literal'+i+'</b>'}));
  view=new ComponentMap([...markers,{lat:90,lon:200,label:'Pole'},{lat:'bad',lon:0,label:'Invalid'}],undefined);
  view.setActive(false);win.set_content(view.widget);win.present();await wait(80);check(view.map&&view.layer.get_markers().length===204,'native map/complete marker set missing');check(!view.baseLayer,'coordinate-only map fetched tiles');
  view.setActive(true);await wait(80);const select=all(view.widget,w=>w instanceof Gtk.DropDown)[0];select.selected=202;all(view.widget,w=>w instanceof Gtk.Button&&w.label==='Показать точку')[0].emit('clicked');check(Math.abs(view.map.get_viewport().get_latitude()-55.902)<1e-6,'last point not centered');check(view.selected.get_text().includes('<b>Literal202</b>'),'point popup text lost');
  const first=view.layer.get_markers().find(marker=>marker.get_child().tooltip_text==='Point0').get_child();check(all(first.get_popover().get_child(),w=>w instanceof Gtk.Label&&w.get_text()==='<b>Literal0</b>'&&!w.use_markup).length,'popup interpreted HTML');
  const expander=all(view.widget,w=>w instanceof Gtk.Expander&&w.label==='Список точек')[0];expander.expanded=true;const next=all(expander,w=>w instanceof Gtk.Button&&w.label==='Следующие строки')[0];for(let i=0;i<4;i++)next.emit('clicked');check(all(expander,w=>w instanceof Gtk.Label&&w.get_text()==='Invalid').length,'unplottable record lost from table');
  view.setActive(false);check(!view.baseLayer&&!view.idle,'paused map retained load work');const old=view.map;view.release();check(!view.map&&!view.reference&&!old.get_parent(),'release retained map resources');
  widget=new WidgetView({base:'http://127.0.0.1:1'}, {skill:'test',tab_id:'map',title:'Map',revision:'1',render:{kind:'declarative',components:[{type:'map',markers}]}});win.set_content(widget.widget);widget.setActive(true);await wait(60);const owned=[...widget.maps][0],map=owned.map;map.get_map().center_on(56,38);map.get_viewport().set_zoom_level(7);widget.session.publish('result','success',{unrelated:'update'});await wait(30);check(owned.map===map&&Math.abs(map.get_viewport().get_latitude()-56)<1e-6&&map.get_viewport().get_zoom_level()===7,'data update reset map state');widget.close();check(!owned.map&&!owned.baseLayer,'widget close retained map');
  print('OK: native coordinate-only map, 204 plotted markers and full invalid-record table, literal popup/last-point selection, pause/release and stable widget map on data refresh; no tile source or network');
 })().catch(error=>{failed=true;logError(error)}).finally(()=>{view?.release();widget?.close();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
