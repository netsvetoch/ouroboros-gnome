import katex from 'katex';
import {mathjax} from 'mathjax-full/js/mathjax.js';
import {MathML} from 'mathjax-full/js/input/mathml.js';
import {SVG} from 'mathjax-full/js/output/svg.js';
import {liteAdaptor} from 'mathjax-full/js/adaptors/liteAdaptor.js';
import {RegisterHTMLHandler} from 'mathjax-full/js/handlers/html.js';
const adaptor=liteAdaptor({fontSize:16});RegisterHTMLHandler(adaptor);
export const mathParserVersion=katex.version;
export function texMathML(source,display=true,macros={}) {
 const markup=katex.renderToString(source,{displayMode:display,output:'mathml',macros,strict:false,trust:false,throwOnError:true,maxExpand:1000});
 const start=markup.indexOf('<math '),end=markup.lastIndexOf('</math>');
 if(start<0||end<start)throw new Error('KaTeX did not produce MathML');
 return markup.slice(start,end+7);
}
export function mathSvg(source,display=true,macros={}) {
 const mml=texMathML(source,display,macros).replaceAll('<mspace mathbackground="black"', '<mspace mathbackground="currentColor"');
 const output=new SVG({fontCache:'none'});
 const document=mathjax.document('',{InputJax:new MathML(),OutputJax:output});
 const node=document.convert(mml,{display,em:16,ex:8,containerWidth:1280});
 const svg=adaptor.tags(node,'svg')[0];
 return {svg:adaptor.outerHTML(svg),viewBox:adaptor.getAttribute(svg,'viewBox')};
}
