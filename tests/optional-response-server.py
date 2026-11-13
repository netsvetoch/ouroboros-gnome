"""Finite raw HTTP responses: distinguish final headers from body/connection failures."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
import json
import socket
import sys
import threading
import time

run = Path(sys.argv[1])
records = []
gates = {}
lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *args):
        pass

    def reply(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlsplit(self.path)
        if url.path == '/facts':
            with lock:
                return self.reply([dict(record) for record in records])
        if url.path == '/release':
            identity = parse_qs(url.query)['id'][0]
            with lock:
                gate = gates.get(identity)
            if gate:
                gate.set()
            return self.reply({'ok': True})
        self.send_error(404)

    def do_POST(self):
        url = urlsplit(self.path)
        _, _, status, mode = url.path.split('/')
        identity = parse_qs(url.query)['id'][0]
        self.rfile.read(int(self.headers.get('Content-Length', '0')))
        record = {'id': identity, 'status': int(status), 'mode': mode,
                  'headers': False, 'closed': False,
                  'authenticated': self.headers.get('Authorization') == 'Bearer fixture-secret'}
        gate = threading.Event()
        with lock:
            records.append(record)
            gates[identity] = gate
        try:
            if mode == 'before':
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                return
            data = json.dumps({'notice': 'Receipt Ω'}).encode()
            self.send_response(int(status))
            self.send_header('Content-Type', 'text/plain' if mode == 'mime' else 'application/json')
            if mode == 'chunk':
                self.send_header('Transfer-Encoding', 'chunked')
            else:
                self.send_header('Content-Length', str(4096 if mode == 'cut' else len(data)))
            self.end_headers()
            self.wfile.write(b'1\r\n{\r\n' if mode == 'chunk' else data[:1] if mode in ('cut', 'hold') else data)
            self.wfile.flush()
            with lock:
                record['headers'] = True
            if mode == 'chunk':
                time.sleep(.15)
                self.wfile.write(b'not-a-size\r\nx\r\n0\r\n\r\n')
                self.wfile.flush()
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
            elif mode == 'cut':
                time.sleep(.15)
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
            elif mode == 'hold':
                gate.wait(30)
                self.wfile.write(data[1:])
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with lock:
                record['closed'] = True


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
(run / 'port').write_text(str(server.server_port))
server.serve_forever()
