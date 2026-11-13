import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {chatFrameAccepts,chatThreadAccepts} from '../dist-gjs/gjs/chat-room.js';

test('matches pinned primary Main/Project fan-out for canonical and legacy envelopes',()=>{
 const path=process.env.OUROBOROS_REFERENCE;assert.ok(path,'OUROBOROS_REFERENCE is required');
 const source=readFileSync(path+'/web/modules/chat_activity.js','utf8');
 const functions=source.slice(source.indexOf('export function mainThreadAccepts('),source.indexOf('export const TERMINAL_TASK_STATUSES'));
 const oracle=Function(functions.replaceAll('export function ','function ')+';return {chatThreadAccepts,chatLogThreadAccepts};')();
 const projects=new Set([88,9007199254740001]);let count=0;
 for(const room of [1,88,701])for(const chat of [undefined,null,0,-77,1,88,701,999999999999,9007199254740001,'701']){
  for(const stamp of [undefined,false,true])for(const also of [undefined,[],[1],[88],[701],['701']]){
   const frame={type:'chat',...(chat===undefined?{}:{chat_id:chat}),...(stamp===undefined?{}:{project_thread:stamp}),...(also===undefined?{}:{also_rooms:also})};
   assert.equal(chatThreadAccepts(frame,room,projects),oracle.chatThreadAccepts(frame,room===1,room,projects),JSON.stringify({room,frame}));count++;
   for(const inner of [undefined,{}, {chat_id:chat}, {chat_id:0}, {chat_id:88}, {chat_id:701}]){
    const log={...frame,type:'log',...(inner===undefined?{}:{data:inner})};
    assert.equal(chatFrameAccepts(log,room,projects),oracle.chatLogThreadAccepts(log,room===1,room,projects),JSON.stringify({room,log}));count++;
   }
  }
 }
 assert.ok(count>3000);
});
test('malformed room identities cannot create Main events',()=>{
 for(const chat_id of [NaN,Infinity,{},[],true,false,1.5,Number.MAX_SAFE_INTEGER+1])assert.equal(chatThreadAccepts({chat_id},1,new Set()),false);
 assert.equal(chatFrameAccepts({type:'log',project_thread:false,data:{project_thread:true,chat_id:701}},1,new Set()),false);
});
