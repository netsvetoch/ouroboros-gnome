import assert from 'node:assert/strict';
import test from 'node:test';
import {kanbanColumns} from '../dist-gjs/gjs/component-kanban-model.js';

test('all columns and cards remain available beyond the former limits',()=>{
 const columns=Array.from({length:25},(_,i)=>({id:'c'+i,label:'Column '+i}));
 const cards=Array.from({length:203},(_,i)=>({label:'Card '+i,column:'c0'}));cards.push({id:'last',column:'c24',label:'Last column'});
 const board=kanbanColumns(columns,cards);assert.equal(board.length,25);assert.equal(board[0].cards.length,203);assert.equal(board[0].cards[202].id,'c0-202');assert.equal(board[24].cards[0].id,'last');
});
test('implicit IDs use the index within a column before pagination',()=>{
 const board=kanbanColumns([{id:'todo'},{label:'Done'}],[{label:'A'},{id:'explicit',column:'Done'},{label:'B',col:'todo'},{id:'',label:'C',column:'Done'}]);
 assert.deepEqual(board[0].cards.map(card=>card.id),['todo-0','todo-1']);assert.deepEqual(board[1].cards.map(card=>card.id),['explicit','Done-1']);
});
test('truthy ID/label/column fallbacks match the gateway web renderer',()=>{
 const [column]=kanbanColumns([{id:'',label:'Fallback'}],[{id:0,column:'',col:'',label:'',title:'Title'}]);
 assert.equal(column.id,'Fallback');assert.equal(column.cards[0].id,'Fallback-0');assert.equal(column.cards[0].label,'Title');
});
test('unknown columns remain visible and anonymous draft identity changes with contents',()=>{
 const columns=[{id:'todo'}];const first=kanbanColumns(columns,[{column:'missing',label:'Unassigned'},{label:'Before'}]);
 assert.equal(first[1].known,false);assert.equal(first[1].cards[0].label,'Unassigned');
 const second=kanbanColumns(columns,[{label:'After'}]);assert.notEqual(first[0].cards[0].key,second[0].cards[0].key);
 const a=kanbanColumns(columns,[{id:'stable',label:'Before'}])[0].cards[0],b=kanbanColumns(columns,[{id:'stable',label:'After'}])[0].cards[0];assert.equal(a.key,b.key);
});
test('empty groups, duplicate keys and input records are preserved without mutation',()=>{
 const columns=[{id:'todo',label:'First'},{id:'todo',label:'Second'},{id:'empty'}],cards=[{id:'one',column:'todo'}];const before=JSON.stringify({columns,cards});const board=kanbanColumns(columns,cards);
 assert.equal(board[0].cards.length,1);assert.equal(board[1].cards.length,1);assert.equal(board[2].cards.length,0);assert.equal(JSON.stringify({columns,cards}),before);
});
