import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {exit} from 'system';
const base=ARGV[0]??Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_child('dist-gjs').get_child('gjs').get_uri()+'/';
const {ComponentGallery}=await import(base+'component-gallery.js');
const {mountComponents}=await import(base+'card-components.js');
const {WidgetView}=await import(base+'widget-view.js');
const wait=ms=>new Promise(resolve=>GLib.timeout_add(0,ms,()=>{resolve();return GLib.SOURCE_REMOVE}));
const check=(ok,why)=>{if(!ok)throw new Error(why)};
function all(w,p){let out=p(w)?[w]:[];for(let c=w.get_first_child();c;c=c.get_next_sibling())out.push(...all(c,p));return out}
const click=(root,text)=>{const button=all(root,w=>w instanceof Gtk.Button&&w.label===text)[0];check(button,'missing '+text);button.emit('clicked')};
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNomLDgPwAF9AKw7aBF7QAAAABJRU5ErkJggg==';
const pngBytes=GLib.Bytes.new(GLib.base64_decode(png.split(',')[1]));
const app=new Adw.Application({flags:Gio.ApplicationFlags.NON_UNIQUE});let failed=false;
app.connect('activate',()=>{
 const win=new Adw.ApplicationWindow({application:app,default_width:900,default_height:700});let gallery,card,widget,audio,delayed;
 (async()=>{
  const requests=[];
  const gateway={base:'http://127.0.0.1:1',bytes:async path=>{requests.push(path);return pngBytes}};
  const values=Array.from({length:263},(_,i)=>` folder/image ${i}&.png `);
  gallery=new ComponentGallery(gateway,'gallery',{items_key:'photos',route_prefix:'media?filename=',item_type:'image'});
  win.set_content(new Gtk.ScrolledWindow({child:gallery.widget}));win.present();gallery.setData({photos:values});await wait(100);
  check(requests.length===20&&gallery.current.length===20,'first page fetched the entire gallery');
  check(requests[0]==='/api/extensions/gallery/media?filename=folder%2Fimage%200%26.png','route prefix lost encoding/trim');
  check(all(gallery.widget,w=>w instanceof Gtk.Picture).length===20,'first page did not decode native pictures');
  const old=gallery.current[0];
  for(let i=0;i<13;i++)click(gallery.widget,'Следующие файлы');await wait(100);
  check(gallery.current.length===3&&requests.length===263,'gallery truncated or fetched beyond its last page');
  check(requests.at(-1).includes('image%20262%26.png'),'last item missing');
  check(!old.widget.get_parent(),'previous page retained its widget');
  check(gallery.position.label==='Файлы 261–263 из 263'&&!gallery.next.sensitive,'last page bounds incorrect');
  const count=requests.length;gallery.setData({photos:[...values],unrelated:true});await wait(20);
  check(requests.length===count&&gallery.start===260,'unchanged items reloaded or reset the page');
  gallery.setData({photos:values.slice(0,22)});await wait(30);
  check(gallery.start===20&&gallery.current.length===2,'shortened collection did not clamp the page');
  gallery.setData({photos:[]});check(gallery.current.length===0&&!gallery.controls.visible,'empty gallery retained media/navigation');
  gallery.release();gallery.setData({photos:values});check(gallery.current.length===0,'closed gallery accepted an update');

  // Card gallery items are not structural nodes in the upstream 256-node limit.
  card=mountComponents([{type:'gallery',items:Array.from({length:263},(_,i)=>({type:i?'image':'',src:png,label:'Caption'+i,alt:'Photo'+i}))},{type:'markdown',text:'After gallery'}],{},()=>{});
  win.set_content(new Gtk.ScrolledWindow({child:card.widget}));await wait(40);
  check(all(card.widget,w=>w instanceof Gtk.Picture).length===20,'default/empty media type did not become image');
  check(all(card.widget,w=>w instanceof Gtk.Label&&w.get_text()==='Caption0'&&w.visible).length,'image caption disappeared after loading');
  check(all(card.widget,w=>w instanceof Gtk.Label&&w.get_text()==='After gallery').length,'gallery consumed structural component budget');
  for(let i=0;i<13;i++)click(card.widget,'Следующие файлы');await wait(40);
  const pictures=all(card.widget,w=>w instanceof Gtk.Picture);
  check(pictures.length===3&&pictures.at(-1).alternative_text==='Photo262','card gallery truncated media');
  card.close();check(!all(card.widget,w=>w instanceof Gtk.Picture).length,'card close retained gallery media');

  // An unchanged static item can point to a changed value in the response.
  widget=new WidgetView(gateway,{skill:'gallery',tab_id:'photos',title:'Photos',revision:'1',render:{kind:'declarative',components:[{type:'gallery',items:[{type:'image',path:'photo'}]}]}});
  win.set_content(widget.widget);widget.setActive(true);widget.session.publish('result','success',{photo:'/api/extensions/gallery/first'});await wait(30);
  const owned=[...widget.galleries][0];const first=owned.current[0];
  widget.session.publish('result','success',{photo:'/api/extensions/gallery/second'});await wait(30);
  check(owned.current[0]===first&&requests.at(-1)==='/api/extensions/gallery/second','static gallery media ignored changed response fields');
  widget.close();check(owned.current.length===0&&widget.galleries.size===0,'widget close retained media');

  const resolutions=[],cancellations=[];
  delayed=new ComponentGallery({bytes:(_path,cancel)=>{cancellations.push(cancel);return new Promise(r=>{resolutions.push(r)})}},'gallery',{items:Array.from({length:21},()=>({route:'late'}))});
  delayed.setData({});const stale=delayed.current[0];click(delayed.widget,'Следующие файлы');delayed.release();for(const resolve of resolutions)resolve(pngBytes);await wait(30);
  check(cancellations.length===21&&cancellations.every(cancel=>cancel.is_cancelled()),'page/close did not cancel HTTP transfers');
  check(!all(stale.widget,w=>w instanceof Gtk.Picture).length&&!delayed.current.length,'late response revived released media');

  const wav=new Uint8Array(844),dv=new DataView(wav.buffer);const ascii=(offset,s)=>{for(let i=0;i<s.length;i++)wav[offset+i]=s.charCodeAt(i)};
  ascii(0,'RIFF');dv.setUint32(4,836,true);ascii(8,'WAVEfmt ');dv.setUint32(16,16,true);dv.setUint16(20,1,true);dv.setUint16(22,1,true);dv.setUint32(24,8000,true);dv.setUint32(28,8000,true);dv.setUint16(32,1,true);dv.setUint16(34,8,true);ascii(36,'data');dv.setUint32(40,800,true);wav.fill(128,44);
  const src='data:audio/wav;base64,'+GLib.base64_encode(wav);
  audio=new ComponentGallery(undefined,'',{items:Array.from({length:21},()=>({type:'audio',src}))});audio.setData({});win.set_content(new Gtk.ScrolledWindow({child:audio.widget}));
  const media=audio.current[0];click(media.widget,'Открыть аудио');await wait(100);const file=media.file;
  check(file?.query_exists(null)&&media.stream&&all(media.widget,w=>w instanceof Gtk.MediaControls).length,'native audio did not open');
  let pauses=0;const pause=media.pause.bind(media);media.pause=()=>{pauses++;pause()};audio.setActive(false);check(pauses===1,'inactive gallery did not pause media');
  click(audio.widget,'Следующие файлы');check(!file.query_exists(null)&&!media.stream&&!media.file,'page change retained audio/temp file');audio.release();
  print('OK: native galleries expose all 263 items in cards/widgets, fetch only visible pages, preserve page/refresh response fields, encode route_prefix, clamp/empty collections, ignore late responses and release audio/files on navigation/close');
 })().catch(error=>{failed=true;logError(error)}).finally(()=>{gallery?.release();card?.close();widget?.close();audio?.release();delayed?.release();win.close();app.quit()});
});await app.runAsync([]);exit(failed?1:0);
