#!/usr/bin/env python3
"""Bundle the pinned TeX-to-SVG engine; no browser, fonts or network at runtime."""
from pathlib import Path
import base64,hashlib,json,shutil,subprocess,tempfile
ROOT=Path(__file__).resolve().parents[1]
PACKAGES={
 'mathjax-full':('3.2.2','sha512-+LfG9Fik+OuI8SLwsiR02IVdjcnRCy5MufYLi0C3TdMT56L/pjB0alMVGgoWJF8pN9Rc7FESycZB9BMNWIid5w=='),
 'katex':('0.17.0','sha512-Vdw0ATsQ9V+LuegM/BTwQqV/6cTl5lbGcIrU+BCgLxyf6bo38ybOr372tuSIxir3CN720flu1meYR6XzNMwQnw==')}
def run(args,cwd):return subprocess.run(args,cwd=cwd,check=True,text=True,capture_output=True).stdout
with tempfile.TemporaryDirectory(prefix='ouroboros-math-build-') as directory:
 work=Path(directory);archives=[]
 for name,(version,integrity) in PACKAGES.items():
  result=json.loads(run(['npm','pack',name+'@'+version,'--json'],work));pack=result[0] if isinstance(result,list) else result[name]
  archive=work/pack['filename'];actual='sha512-'+base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode()
  if actual!=integrity or pack['integrity']!=integrity:raise SystemExit('Archive integrity mismatch: '+name)
  archives.append(str(archive))
 run(['npm','install','--prefix',directory,'--ignore-scripts','--no-package-lock','--no-audit','--no-fund',*archives,'esbuild@0.28.2'],work)
 shutil.copyfile(ROOT/'vendor/math-engine-source.js',work/'entry.js')
 run([str(work/'node_modules/.bin/esbuild'),'entry.js','--bundle','--platform=browser','--format=esm','--target=es2022','--legal-comments=inline','--outfile=math-engine.js'],work)
 target=ROOT/'src/gjs/vendor/math-engine.js';target.write_text('// Generated from katex 0.17.0 and mathjax-full 3.2.2 using esbuild 0.28.2.\n// Licenses and reproduction: repository vendor/README.md.\n'+(work/'math-engine.js').read_text())
 for name in PACKAGES:
  folder=work/'node_modules'/name;license=next(path for path in [folder/'LICENSE',folder/'LICENSE.txt'] if path.exists());shutil.copyfile(license,ROOT/'vendor'/(name+'.LICENSE'))
 print('bundle bytes',target.stat().st_size,'SHA256',hashlib.sha256(target.read_bytes()).hexdigest())
