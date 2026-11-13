"""Produce actual pinned receipt folds; no workers, models, or accounting writes."""
import copy,json,pathlib,sys
from ouroboros.swarm_receipt import fold_tree
root='swarm-audit'
def actor(key,start,end,kind='task',task=None):
    return dict(id=key,task_id=task or root,kind=kind,start=start,end=end,terminal=end is not None,collected=True)
a=actor('task:'+root,0,5,'supervisor')
b=actor('task:helper',5,12,task='helper')
c=actor('run:pending',None,None,'delegated_start')
usage=[dict(attempt_id='attempt-Ω',task_id=root,model='Model <&> Ω',kind='api_call',cost_usd=.125,cost_final=True,provider='Fixture provider',credential_profile_id='profile <&>',physical_context={'window_tokens':32000},prompt_tokens=120),
 dict(attempt_id='session-1',task_id='helper',kind='subscription_session',model='Session model',cost_usd=None,cost_final=False),
 dict(attempt_id='session-2',task_id='helper',kind='subscription_session',model='Session model',cost_usd=None,cost_final=False)]
complete=dict(tree='complete',usage='complete',causal_edges='complete',history_before_instrumentation='unknown',gaps=[])
known=fold_tree(root,[a,b],edges=[{'from':a['id'],'to':b['id'],'observed':True}],coverage=complete,usage=usage[:1],refused_starts=[],mind_comparison={'conclusion':'Literal comparison <&> Ω','caveat':'Mind authored, not measured'})
known.update(revision=7,published_at='2026-11-13T00:00:00Z')
partial=fold_tree(root,[a,b,c],waits=[{'wait_id':'wait Ω','selected_task_ids':['helper'],'state':'waiting'}],coverage={**complete,'usage':'unknown','causal_edges':'unknown','gaps':['missing_usage']},usage=usage,refused_starts=[{'invocation_id':'refused Ω','task_id':root,'reason':'No route <&>'}])
parallel=fold_tree(root,[a,actor('task:parallel',0,5,task='parallel')],coverage=complete,refused_starts=[])
bad=copy.deepcopy(known);bad.update(actor_intervals=[None,42],refused_starts='broken',cost={'known_final_usd':None,'total_usd':None,'attempts':[None]},longest_causal_path={'seconds':999,'observed_seconds':2,'coverage':'missing_intervals_or_edges'})
foreign={**known,'root_task_id':'other-task'}
cases=[]
for name,receipt in [('known',known),('partial',partial),('parallel',parallel),('malformed',bad),('foreign',foreign),('absent',None)]:
    cases.append({'name':name,'detail':{'task_id':root,'status':'completed','metadata':{'subagents_mode':'swarm'},'swarm_efficiency':{'subagent_count':3},'swarm_receipt':receipt}})
pathlib.Path(sys.argv[1],'swarm-cases.json').write_text(json.dumps(cases,ensure_ascii=False))
print('OK: actual pinned fold_tree produced complete, partial, parallel, unknown costs and authored comparison; malformed/foreign replies are controlled faults')
