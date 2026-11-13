from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit
import json,struct,zlib,sys,time
run=Path(sys.argv[1]);records=[]
def chunk(kind,data):return struct.pack('!I',len(data))+kind+data+struct.pack('!I',zlib.crc32(kind+data))
png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!IIBBBBB',1,1,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(b'\0\x80\x90\xa0\xff'))+chunk(b'IEND',b'')
svg=b'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="12"><rect width="20" height="12" fill="#ff0000"/></svg>'
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def reply(self,status,body=b'',headers=None):
  self.send_response(status)
  for key,value in (headers or {}).items():self.send_header(key,value)
  self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
 def do_POST(self):
  self.rfile.read(int(self.headers.get('Content-Length','0')))
  self.reply(200,b'{"ok":true}',{'Content-Type':'application/json','Set-Cookie':'ouroboros_auth=fixture-session; Path=/; HttpOnly'})
 def do_GET(self):
  path=urlsplit(self.path).path
  if path=='/audit':return self.reply(200,json.dumps(records).encode(),{'Content-Type':'application/json'})
  entry={'path':self.path,'auth':self.headers.get('Authorization'),'cookie':self.headers.get('Cookie')};records.append(entry)
  if path.startswith('/api/files/download') or path.startswith('/api/tasks/'):
   if entry['auth']!='Bearer fixture-secret' or 'ouroboros_auth=fixture-session' not in (entry['cookie'] or ''):return self.reply(401)
   return self.reply(200,png,{'Content-Type':'image/png'})
  if path=='/redirect':return self.reply(302,headers={'Location':'/png','Set-Cookie':'external=do-not-store; Path=/'})
  if path=='/loop':return self.reply(302,headers={'Location':'/loop'})
  if path=='/invalid-redirect':return self.reply(302,headers={'Location':'file:///tmp/secret'})
  if path=='/png':return self.reply(200,png,{'Content-Type':'application/octet-stream'})
  if path in ['/gif','/jpg','/webp']:return self.reply(200,(Path(__file__).parent/'fixtures'/('diagram-image'+path.replace('/','.'))).read_bytes())
  if path=='/svg':return self.reply(200,svg,{'Content-Type':'image/svg+xml'})
  if path=='/bad':return self.reply(200,b'not an image')
  if path=='/large':
   self.send_response(200);self.send_header('Content-Length',str(16*1024*1024+1));self.end_headers();return
  if path=='/chunk-large':
   self.send_response(200);self.end_headers()
   try:
    for i in range(17):self.wfile.write(b'x'*(1024*1024));self.wfile.flush()
   except (BrokenPipeError,ConnectionResetError):entry['cancelled']=True
   return
  if path=='/slow':
   self.send_response(200);self.send_header('Content-Length',str(len(png)));self.end_headers()
   try:self.wfile.write(png[:10]);self.wfile.flush();time.sleep(4);self.wfile.write(png[10:]);self.wfile.flush()
   except (BrokenPipeError,ConnectionResetError):entry['cancelled']=True
   return
  return self.reply(404)
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);(run/'port').write_text(str(server.server_port));server.serve_forever()
