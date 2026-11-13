"""Actual pinned root-attempt predicate over canonical and metadata carriers."""
import json,pathlib,sys
from ouroboros.task_results import resolve_task_lineage
root='lineage-gate'
cases=[('root',{}),('child',{'parent_task_id':'parent','root_task_id':'parent'}),
 ('metadata-child',{'metadata':{'parent_task_id':'parent','root_task_id':'parent'}}),
 ('subagent-role',{'root_task_id':root,'delegation_role':'subagent'}),
 ('explicit-empty-parent',{'parent_task_id':'','metadata':{'parent_task_id':'stale-parent'}}),
 ('null-parent-fallback',{'parent_task_id':None,'metadata':{'parent_task_id':'parent'}}),
 ('retry',{'root_task_id':'logical-root','delegation_role':' ROOT ','original_task_id':'previous','timeout_retry_from':'previous'}),
 ('retry-missing-marker',{'root_task_id':'logical-root','delegation_role':'root','original_task_id':'previous'}),
 ('retry-mismatched-markers',{'root_task_id':'logical-root','delegation_role':'root','original_task_id':'previous','timeout_retry_from':'different'}),
 ('retry-child',{'parent_task_id':'parent','root_task_id':'logical-root','delegation_role':'root','original_task_id':'previous','timeout_retry_from':'previous'}),
 ('retry-self',{'root_task_id':'logical-root','delegation_role':'root','original_task_id':root,'timeout_retry_from':root}),
 ('metadata-retry',{'metadata':{'root_task_id':'logical-root','delegation_role':'root','original_task_id':'previous','timeout_retry_from':'previous'}}),
 ('explicit-root',{'root_task_id':root,'metadata':{'root_task_id':'different','delegation_role':'root'}}),
 ('explicit-empty-root',{'root_task_id':'','metadata':{'root_task_id':'different'}}),
 ('foreign-root',{'root_task_id':'different'}),('unknown-role-retry',{'root_task_id':'different','delegation_role':'future-role','original_task_id':'previous','timeout_retry_from':'previous'})]
rows=[]
for name,value in cases:
 projection=resolve_task_lineage(root,metadata=value.get('metadata'),**{k:v for k,v in value.items() if k!='metadata'})
 rows.append({'name':name,'task':value,'root':projection['is_root_task'],'projection':projection})
pathlib.Path(sys.argv[1],'lineage-cases.json').write_text(json.dumps(rows))
print('OK: actual resolve_task_lineage produced '+str(len(rows))+' canonical/metadata/retry cases')
