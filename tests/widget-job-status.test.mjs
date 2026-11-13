import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {readWidgetJobStatus, classifyWidgetJobStatus} from '../dist-gjs/gjs/widget-job-status.js';
const reference=process.env.OUROBOROS_REFERENCE;
assert.ok(reference,'OUROBOROS_REFERENCE is required');
const primary=await import(pathToFileURL(reference+'/web/modules/widget_job.js'));
test('job status matches actual upstream policy, including own null status precedence',()=>{
 const cases=[undefined,null,[],42,'done',{}, {status:null,state:'done'},{status:false,state:'done'},{status:0},{status:1},{status:[]},{status:{}},{status:''},{status:'  '},{state:'done'},{status:' DONE '},{status:'FAILED'},{status:'running'},{status:'producer_specific_wait'},{status:'queued'},{status:'expired'}];
 for(const value of cases){assert.deepEqual(readWidgetJobStatus(value),primary.readWidgetJobStatus(value));assert.equal(classifyWidgetJobStatus(readWidgetJobStatus(value)),primary.classifyWidgetJobStatus(primary.readWidgetJobStatus(value)))}
});
