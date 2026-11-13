#!/usr/bin/env python3
"""Run package test commands against one build, recording exact inputs and per-test evidence.

A passing report describes the selected checks, not complete API coverage.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--test', action='append', help='Exact package.json test script; repeat to select checks')
parser.add_argument('--output', type=Path, help='New directory for logs and report.json')
parser.add_argument('--keep-going', action='store_true', help='Run remaining checks after a failure')
parser.add_argument('--timeout', type=int, default=600, help='Maximum seconds for each check (default: 600)')
args = parser.parse_args()
scripts = json.loads((root / 'package.json').read_text())['scripts']
names = args.test or [name for name in scripts if name.startswith('test:')]
if args.timeout < 1 or not names or len(names) != len(set(names)) or any(name not in scripts or not name.startswith('test:') for name in names):
    parser.error('Select unique existing test scripts and a positive timeout')
if args.output:
    args.output.mkdir(parents=True, exist_ok=False)
    output = args.output.resolve()
else:
    output = Path(tempfile.mkdtemp(prefix='ouroboros-native-suite.'))
env = {**os.environ, 'GTK_IM_MODULE': 'simple'}
# GUI checks run sequentially. Never rebuild dist while an earlier GJS check is still importing it.
inputs = {}
for folder in ('src', 'scripts', 'tests', 'vendor'):
    for path in sorted((root / folder).rglob('*')):
        if path.is_file() and '__pycache__' not in path.parts and path.suffix not in ('.pyc', '.png', '.mp4', '.wav'):
            inputs[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
for name in ('package.json', 'tsconfig.json', 'tsconfig.gjs.json', 'io.github.ouroboros.Client.json'):
    inputs[name] = hashlib.sha256((root / name).read_bytes()).hexdigest()
report = {'started_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'status': 'running',
          'workspace': str(root), 'reference': env.get('OUROBOROS_REFERENCE'),
          'python': env.get('OUROBOROS_TEST_PYTHON'), 'inputs_sha256': inputs,
          'selection': names, 'results': [], 'limitation': 'Selected check results do not prove complete API coverage.'}
def save():
    pending = output / 'report.tmp'
    pending.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    pending.replace(output / 'report.json')

def run(name, command):
    log = output / (name.replace(':', '-') + '.log')
    item = {'name': name, 'command': command, 'status': 'running', 'log': str(log)}
    report['results'].append(item)
    save()
    start = time.monotonic()
    with log.open('w') as stream:
        process = subprocess.Popen(['bash', '-lc', command], cwd=root, env=env,
                                   stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
        item['pid'] = process.pid
        save()
        try:
            code = process.wait(timeout=args.timeout)
        except (subprocess.TimeoutExpired, KeyboardInterrupt) as error:
            # Only this check's process group is terminated; no user processes are selected by name.
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            code = 124 if isinstance(error, subprocess.TimeoutExpired) else 130
    item.update(status='passed' if code == 0 else 'failed', exit_code=code,
                seconds=round(time.monotonic() - start, 2))
    item['observations'] = [line for line in log.read_text(errors='replace').splitlines() if line.startswith(('OK:', 'Logs at '))]
    save()
    print(f'{item["status"].upper()} {name} ({item["seconds"]}s) · {log}', flush=True)
    return code

print(f'Evidence: {output}', flush=True)
save()
code = run('build', 'npm run build')
if code == 0:
    for name in names:
        command = scripts[name]
        prefix = 'npm run build && '
        if command.startswith(prefix):
            command = command[len(prefix):]
        code = run(name, command)
        if code and (not args.keep_going or code == 130):
            break
report['finished_at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
report['status'] = 'passed' if len(report['results']) == len(names) + 1 and all(item['status'] == 'passed' for item in report['results']) else 'failed'
save()
raise SystemExit(0 if report['status'] == 'passed' else 1)
