import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {chatSender} from '../dist-gjs/gjs/chat-sender.js';
test('sender captions agree with the pinned primary browser for valid fields',()=>{
 const path=process.env.OUROBOROS_REFERENCE;assert.ok(path,'OUROBOROS_REFERENCE is required');
 const source=readFileSync(path+'/web/modules/chat_activity.js','utf8');
 const body=source.slice(source.indexOf('export function senderLabel('),source.indexOf('export function isLiveLineExpandable('));
 const oracle=Function(body.replace('export function ','function ')+';return senderLabel;')();let count=0;
 for(const role of ['user','assistant','system'])for(const source of [undefined,'web','telegram','external'])for(const sender of [undefined,'','Alice <&> Ω','  literal  '])
 for(const progress of [false,true])for(const system of ['', 'task_summary','skill_review'])for(const initiator of [undefined,'consciousness','owner']){
  const row={role,source,sender_label:sender,is_progress:progress,system_type:system,initiator};const caption=chatSender(row);
  assert.equal(caption.sender??caption.english,oracle(role,progress,system,{source,senderLabel:sender,initiator}),JSON.stringify(row));count++;
 }
 assert.equal(count,864);
});
test('malformed display metadata cannot supply a name or claim progress',()=>{
 for(const value of [null,{},[],false,42])assert.equal(chatSender({role:'user',sender_label:value}).english,'You');
 assert.equal(chatSender({role:'assistant',is_progress:'false'}).english,'Ouroboros');
 assert.equal(chatSender({role:'system',sender_label:'spoof',initiator:'consciousness'}).english,'System');
});
