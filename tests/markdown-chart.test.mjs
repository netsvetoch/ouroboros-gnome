import assert from 'node:assert/strict';
import test from 'node:test';
import {parseMarkdownChart,markdownChartTypes} from '../dist-gjs/gjs/markdown-chart.js';
const source=(type='line',data=[1,null,'3'],options={})=>JSON.stringify({type,data:{labels:['A','B','C'],datasets:[{label:'Values',data}]},options});

test('all gateway chart types preserve scalar and structured point data',()=>{
 for(const type of markdownChartTypes){const data=['scatter','bubble'].includes(type)?[{x:2,y:5,r:3},{x:4,y:-1}]:[1,null,'3'];const result=parseMarkdownChart(source(type,data));assert.equal(result.type,type);assert.deepEqual(result.data.datasets[0].data,data)}
});
test('chart boundary retains only the same root, data and dataset keys as upstream',()=>{
 const result=parseMarkdownChart(JSON.stringify({type:'bar',extra:1,plugins:[{id:'foreign'}],data:{labels:['A'],unknown:true,datasets:[{data:[1],label:'A',backgroundColor:'#123456',borderColor:'#654321',borderWidth:2,fill:true,tension:.2,ignored:'discard'}]},options:{responsive:false,maintainAspectRatio:true,scales:{y:{type:'logarithmic'}},plugins:{legend:{display:false}}}}));
 assert.deepEqual(Object.keys(result),['type','data','options']);assert.ok(!('ignored' in result.data.datasets[0]));assert.ok(!('unknown' in result.data));
 assert.equal(result.options.responsive,true);assert.equal(result.options.maintainAspectRatio,false);assert.deepEqual(result.options.scales,{y:{type:'logarithmic'}});assert.deepEqual(result.options.plugins,{legend:{display:false}});
});
test('invalid JSON, unsupported types and malformed arrays reject without coercion',()=>{
 for(const invalid of ['{','[]','null','1',JSON.stringify({type:'area',data:{datasets:[]}}),JSON.stringify({type:'line',data:[]}),JSON.stringify({type:'line',data:{datasets:{}}}),JSON.stringify({type:'line',data:{datasets:[{data:'x'}]}}),JSON.stringify({type:'line',data:{labels:{},datasets:[]}})])assert.throws(()=>parseMarkdownChart(invalid),invalid);
});
test('caps match the gateway and never silently truncate accepted data',()=>{
 const maximum={type:'line',data:{labels:Array(500).fill('x'),datasets:Array.from({length:24},(_,i)=>({label:String(i),data:Array(500).fill(0)}))}};
 const parsed=parseMarkdownChart(JSON.stringify(maximum));assert.equal(parsed.data.datasets.length,24);assert.equal(parsed.data.labels.length,500);assert.equal(parsed.data.datasets[23].data[499],0);
 for(const invalid of [{type:'line',data:{datasets:Array(25).fill({data:[]})}},{type:'line',data:{datasets:[{data:Array(501).fill(0)}]}},{type:'line',data:{datasets:[],labels:Array(501).fill('x')}}])assert.throws(()=>parseMarkdownChart(JSON.stringify(invalid)));
 assert.throws(()=>parseMarkdownChart(' '.repeat(32769)+source()),/32768/);
});
