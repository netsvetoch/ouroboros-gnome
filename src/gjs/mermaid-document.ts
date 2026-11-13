/** Trusted render program. Author input arrives only as a JSON argument. */
export const mermaidProgram = String.raw`
const ouroborosAssets=new Map();let ouroborosAssetSequence=0;
globalThis.ouroborosDiagramAsset=function(id,request,value){const key=id+':'+request,waiting=ouroborosAssets.get(key);if(!waiting)return;ouroborosAssets.delete(key);value.error?waiting.reject(new Error(value.error)):waiting.resolve(value.data);};
globalThis.ouroborosRenderDiagram = async function(config) {
  const send = value => window.webkit.messageHandlers.ouroDiagram.postMessage(JSON.stringify({id:config.id,...value}));
  let blocked=false;
  const denied=event=>{if(!blocked){blocked=true;send({error:'Внешний ресурс диаграммы недоступен: '+event.violatedDirective,fatal:true});}};
  document.addEventListener('securitypolicyviolation',denied);
  const restored=[];
  try {
    document.body.replaceChildren();
    document.body.style.width = Math.max(320, config.width) + 'px';
    const dark = config.dark;
    mermaid.initialize({
      startOnLoad:false, securityLevel:'strict', htmlLabels:true,
      secure:['securityLevel','startOnLoad','maxTextSize','maxEdges','suppressErrorRendering','secure'],
      maxTextSize:50000, maxEdges:500, suppressErrorRendering:true,
      theme:'base',
      fontFamily:'sans-serif',
      themeVariables:{
        fontFamily:'sans-serif', background:dark?'#131415':'#ffffff',
        primaryColor:dark?'#212223':'#eeeeee', primaryTextColor:dark?'#efeff2':'#242424',
        primaryBorderColor:dark?'#717171':'#666666', lineColor:dark?'#989898':'#555555',
        secondaryColor:dark?'#28292a':'#e7e7ed', tertiaryColor:dark?'#151617':'#f6f6f8'
      },
      flowchart:{useMaxWidth:false}, sequence:{useMaxWidth:false},
      class:{useMaxWidth:false}, state:{useMaxWidth:false}
    });
    // Direct database parsing does not perform render()'s configuration reset.
    // Do not inherit an earlier diagram's renderer/directive settings.
    mermaid.mermaidAPI.reset();
    const parsed=await mermaid.mermaidAPI.getDiagramFromText(config.source);
    const vertices=parsed.db.getVertices?.();
    const nodes=vertices instanceof Map?[...vertices.values()]:Object.values(vertices||{});
    const images=new Map(),inlineRaster=source=>/^data:image\/(png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=]+$/i.test(source);
    const loadImage=async source=>{
      if(inlineRaster(source))return source;
      if(images.has(source))return images.get(source);
      const request=++ouroborosAssetSequence,key=config.id+':'+request;
      const data=await new Promise((resolve,reject)=>{ouroborosAssets.set(key,{resolve,reject});send({resource:source,request});});
      images.set(source,data);
      return data;
    };
    const loadImages=async sources=>{
      const queue=[...new Set(sources)];let next=0;
      await Promise.all(Array.from({length:Math.min(4,queue.length)},async()=>{while(next<queue.length)await loadImage(queue[next++]);}));
    };
    await loadImages(nodes.filter(node=>node.img).map(node=>String(node.img)));
    if(images.size) {
      const embed=node=>{if(node&&images.has(String(node.img)))node.img=images.get(String(node.img));};
      // render() reparses the text into a new FlowDB. Adapt its data getters for
      // this job so image URLs become embedded bytes without rewriting labels,
      // hyperlinks, directives or the author's original Mermaid source.
      const prototype=Object.getPrototypeOf(parsed.db);
      for(const name of ['getVertices','getData']) {
        const original=prototype[name];if(typeof original!=='function')continue;
        prototype[name]=function(...args){const value=original.apply(this,args);if(name==='getVertices'){for(const node of value instanceof Map?value.values():Object.values(value||{}))embed(node);}else for(const node of value?.nodes||[])embed(node);return value;};
        restored.push(()=>{prototype[name]=original;});
      }
    }
    // HTML labels are created by several diagram families. Intercept image
    // assignment only during layout, before any element can start a request.
    // An inert template preserves HTML/entity parsing without loading resources.
    // The first layout discovers sources using an embedded placeholder; after
    // native loading, repeat the unchanged source with the actual image sizes.
    const pendingImages=new Set(),placeholder='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNomLDgPwAF9AKw7aBF7QAAAABJRU5ErkJggg==';
    const imageSource=source=>{
      if(!source||inlineRaster(source))return source;
      if(images.has(source))return images.get(source);
      pendingImages.add(source);return placeholder;
    };
    const htmlProperty=Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML');
    const srcProperty=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
    const setAttribute=Element.prototype.setAttribute;
    const htmlImages=value=>{
      if(!/<img\b/i.test(String(value)))return value;
      const template=document.createElement('template');htmlProperty.set.call(template,value);
      for(const img of template.content.querySelectorAll('img')){
        if(img.hasAttribute('srcset'))throw new Error('Адаптивный srcset в подписи диаграммы недоступен.');
        const source=img.getAttribute('src');if(source)setAttribute.call(img,'src',imageSource(source));
      }
      return htmlProperty.get.call(template);
    };
    Object.defineProperty(Element.prototype,'innerHTML',{...htmlProperty,set(value){htmlProperty.set.call(this,htmlImages(value));}});
    Object.defineProperty(HTMLImageElement.prototype,'src',{...srcProperty,set(value){srcProperty.set.call(this,imageSource(String(value)));}});
    Element.prototype.setAttribute=function(name,value){
      if(this.localName==='img'){
        if(String(name).toLowerCase()==='srcset')throw new Error('Адаптивный srcset в подписи диаграммы недоступен.');
        if(String(name).toLowerCase()==='src')value=imageSource(String(value));
      }
      return setAttribute.call(this,name,value);
    };
    const restoreImages=()=>{
      Object.defineProperty(Element.prototype,'innerHTML',htmlProperty);
      Object.defineProperty(HTMLImageElement.prototype,'src',srcProperty);
      Element.prototype.setAttribute=setAttribute;
    };
    restored.push(restoreImages);
    let result;
    for(let pass=0;pass<3;pass++){
      pendingImages.clear();result=await mermaid.render('ouroboros-diagram',config.source);
      if(!pendingImages.size)break;
      if(pass===2)throw new Error('Источники изображений подписи продолжают изменяться.');
      await loadImages(pendingImages);
    }
    restoreImages();
    // Mermaid serializes HTML void tags/entities in some diagram families.
    // Parse its sanitized output as HTML, then serialize the SVG as XML.
    const holder=document.createElement('div');holder.innerHTML=result.svg;
    const svg=holder.querySelector('svg');
    if(!svg) throw new Error('Mermaid вернул некорректный SVG.');
    let box=svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
    if(!box){document.body.append(holder);const ink=svg.getBBox();box=[ink.x-8,ink.y-8,ink.width+16,ink.height+16];svg.setAttribute('viewBox',box.join(' '));}
    if(box.length!==4||!box.every(Number.isFinite)||box[2]<=0||box[3]<=0) throw new Error('Не удалось определить размер диаграммы.');
    if(box[2]>32768||box[3]>32768) throw new Error('Диаграмма превышает размер отображения.');
    svg.setAttribute('width',String(box[2]));svg.setAttribute('height',String(box[3]));
    document.body.append(holder);
    const links=[];
    for(const anchor of svg.querySelectorAll('a')) {
      const href=anchor.getAttribute('href')||anchor.getAttributeNS('http://www.w3.org/1999/xlink','href');
      if(href&&!href.startsWith('#'))links.push({href,label:anchor.textContent.trim()||anchor.getAttribute('aria-label')||anchor.querySelector('img')?.getAttribute('alt')||href});
    }
    // Convert the gateway's HTML labels (including Journey's foreignObject)
    // to native SVG runs after measuring their actual layout.
    const ns='http://www.w3.org/2000/svg',canvas=document.createElement('canvas'),context=canvas.getContext('2d');
    const rootMatrix=svg.getScreenCTM(),inverse=rootMatrix.inverse();
    for(const foreign of [...svg.querySelectorAll('foreignObject')]) {
      if(foreign.querySelector('video,audio,canvas,iframe,svg')) throw new Error('Вложенное медиа в HTML-подписи диаграммы недоступно.');
      const group=document.createElementNS(ns,'g');
      for(const img of foreign.querySelectorAll('img')){
        const style=getComputedStyle(img),rect=img.getBoundingClientRect();
        if(style.display==='none'||style.visibility==='hidden'||!rect.width||!rect.height)continue;
        const source=img.getAttribute('src');if(!inlineRaster(source))throw new Error('Изображение подписи не встроено в SVG.');
        const origin=new DOMPoint(rect.x,rect.y).matrixTransform(inverse),end=new DOMPoint(rect.right,rect.bottom).matrixTransform(inverse);
        const image=document.createElementNS(ns,'image');
        image.setAttribute('href',source);image.setAttribute('x',String(origin.x));image.setAttribute('y',String(origin.y));
        image.setAttribute('width',String(end.x-origin.x));image.setAttribute('height',String(end.y-origin.y));
        image.setAttribute('preserveAspectRatio',style.objectFit==='contain'?'xMidYMid meet':style.objectFit==='cover'?'xMidYMid slice':'none');
        image.setAttribute('opacity',style.opacity);
        const alt=img.getAttribute('alt');if(alt){const title=document.createElementNS(ns,'title');title.textContent=alt;image.append(title);}
        group.append(image);
      }
      const walker=document.createTreeWalker(foreign,NodeFilter.SHOW_TEXT);
      const matrix=foreign.getScreenCTM(),fontScale=Math.hypot(matrix.c,matrix.d)/Math.hypot(rootMatrix.c,rootMatrix.d);
      let node;
      while((node=walker.nextNode())) {
        const style=getComputedStyle(node.parentElement);
        if(style.display==='none'||style.visibility==='hidden') continue;
        context.font=style.font||style.fontSize+' '+style.fontFamily;
        const metrics=context.measureText('Mg'),ascent=metrics.fontBoundingBoxAscent||parseFloat(style.fontSize)*0.8;
        const range=document.createRange();let run;
        const emit=()=>{
          if(!run)return;
          const text=document.createElementNS(ns,'text');text.setAttribute('x',String(run.x));text.setAttribute('y',String(run.y));
          text.setAttribute('style','font-family:'+style.fontFamily+';font-size:'+(parseFloat(style.fontSize)*fontScale)+'px;font-weight:'+style.fontWeight+';font-style:'+style.fontStyle+';fill:'+style.color+';white-space:pre;');
          text.setAttributeNS('http://www.w3.org/XML/1998/namespace','xml:space','preserve');text.textContent=run.text;group.append(text);run=undefined;
        };
        for(let index=0;index<node.length;) {
          const char=String.fromCodePoint(node.textContent.codePointAt(index));range.setStart(node,index);range.setEnd(node,index+char.length);index+=char.length;
          const rect=range.getBoundingClientRect();
          if(!rect.width||!rect.height){if(run&&/[\p{M}\u200c\u200d\ufe00-\ufe0f]/u.test(char))run.text+=char;continue;}
          const point=new DOMPoint(rect.x,rect.y+ascent).matrixTransform(inverse);
          if(run&&Math.abs(run.y-point.y)<0.5)run.text+=char;
          else {emit();run={x:point.x,y:point.y,text:char};}
        }
        emit();
      }
      // switch's SVG fallback would otherwise draw a second copy of the label.
      const fallback=foreign.parentElement?.localName==='switch'?foreign.parentElement:foreign;
      svg.append(group);fallback.remove();
    }
    // librsvg follows SVG whitespace rules at tspan boundaries; retain the
    // leading spaces that Mermaid uses between separately styled words.
    for(const text of svg.querySelectorAll('text')) {
      text.removeAttribute('xml:space');
      text.setAttributeNS('http://www.w3.org/XML/1998/namespace','xml:space','preserve');
      text.style.whiteSpace='pre';
    }
    if(svg.querySelector('script,iframe,object,embed,feImage')) throw new Error('Диаграмма содержит неподдерживаемый вложенный ресурс.');
    const localUrl = value => value.replace(/url\(\s*(['"]?)(?:about:blank)?#([^)'"\s]+)\1\s*\)/gi,'url(#$2)');
    for(const element of [svg,...svg.querySelectorAll('*')]) {
      for(const attr of [...element.attributes]) {
        if(/^on/i.test(attr.name)) {element.removeAttributeNode(attr);continue;}
        if(attr.localName==='href') {
          if(element.localName==='a') {
            if(attr.value&&!attr.value.startsWith('#')) links.push({href:attr.value,label:element.textContent.trim()||element.getAttribute('aria-label')||attr.value});
            element.removeAttributeNode(attr);
          } else if(!attr.value.startsWith('#')&&!/^data:image\/(png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=]+$/i.test(attr.value)) throw new Error('Внешние изображения диаграммы недоступны в локальном SVG.');
        } else if(/url\s*\(/i.test(attr.value)) {
          const value=localUrl(attr.value);
          if(/url\(\s*(?!#)/i.test(value)) throw new Error('Внешний ресурс в стиле диаграммы недоступен.');
          element.setAttribute(attr.name,value);
        }
      }
      if(element.localName==='style') {
        const value=localUrl(element.textContent);
        if(/@import|@font-face|url\(\s*(?!#)/i.test(value)) throw new Error('Внешний стиль диаграммы недоступен.');
        element.textContent=value;
      }
    }
    const output=new XMLSerializer().serializeToString(svg);
    if(output.length>16*1024*1024) throw new Error('SVG диаграммы слишком велик.');
    send({svg:output,width:box[2],height:box[3],links,diagramType:result.diagramType});
  } catch(error) {send({error:String(error?.message||error).slice(0,2000)});}
  finally {
    for(const restore of restored)restore();
    for(const [key,waiting] of ouroborosAssets)if(key.startsWith(config.id+':')){
      ouroborosAssets.delete(key);waiting.reject(new Error('Построение диаграммы завершено.'));
    }
    document.removeEventListener('securitypolicyviolation',denied);document.body.replaceChildren();
  }
};
`;

export const mermaidDocument = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; connect-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src \'none\'; base-uri \'none\'; form-action \'none\'"><meta name="referrer" content="no-referrer"><style>body{margin:0;font-family:sans-serif}</style></head><body></body></html>';
