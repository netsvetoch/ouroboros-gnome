"""A tiny process at the llama.cpp boundary; never loads a model or runs a tool."""
import argparse
import json
import os
import pathlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

parser=argparse.ArgumentParser()
parser.add_argument('--port',type=int,required=True)
parser.add_argument('--n_ctx',type=int,required=True)
args,other=parser.parse_known_args()
run=pathlib.Path(os.environ['LOCAL_MODEL_FIXTURE_RUN'])

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def reply(self,body,status=200):
        raw=json.dumps(body).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
    def do_GET(self):
        self.reply({'data':[{'id':'Fixture local <&> 🔧','meta':{'n_ctx_train':args.n_ctx}}]})
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        with (run/'wire.jsonl').open('a') as f:f.write(json.dumps(body)+'\n')
        mode=(run/'probe-mode').read_text() if (run/'probe-mode').exists() else 'normal'
        tool=bool(body.get('tools'))
        message={'role':'assistant','content':'Hello'}
        if tool and mode!='text-only':message={'role':'assistant','content':None,'tool_calls':[{'id':'fixture-call','type':'function','function':{'name':'get_time','arguments':'{}'}}]}
        self.reply({'id':'fixture-completion','object':'chat.completion','created':0,'model':'local-model',
          'choices':[{'index':0,'message':message,'finish_reason':'tool_calls' if tool and mode!='text-only' else 'stop'}],
          'usage':{'prompt_tokens':10,'completion_tokens':2,'total_tokens':12}})

ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
