from pathlib import Path
import hashlib,base64,json,subprocess,tempfile,shutil
ROOT=Path(__file__).resolve().parents[1]
packages={
 'marked':('18.0.7','sha512-iDVQ5ldaiKXn6b2JroX5kgRfmwgqolW7NpaEzTl1k/2Zh1njIEN9yniyLV/mOvWwtsE8OGgkjsCYvijuPk1dtA=='),
 'parse5':('8.1.1','sha512-EcR/6WDcU7b2N3vQSxKALCk9lXGtUMQxXio008OEMBE0kavu/7JLfBEeFPzi43nMqVDSbEn3QCK+BMCc9zO//w=='),
 'entities':('9.0.0','sha512-oJFNDJg3kTPwAD1cNn2+WmUq4wFoo09npc3Ydf1D7ED4smRiWrsKnaLxykrTWgyGEcusc87P5dxlAleol9kpkg==')}
def run(args,cwd):return subprocess.run(args,cwd=cwd,check=True,text=True,capture_output=True).stdout
with tempfile.TemporaryDirectory(prefix='ouroboros-markdown-build-') as directory:
 work=Path(directory);archives=[]
 for name,(version,expected) in packages.items():
  packs=json.loads(run(['npm','pack',name+'@'+version,'--json'],work));package=packs[0] if isinstance(packs,list) else packs[name];archive=work/package['filename'];actual='sha512-'+base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode()
  if expected!=package['integrity'] or actual!=expected:raise SystemExit('archive integrity mismatch: '+name)
  archives.append(str(archive))
 run(['npm','install','--prefix',directory,'--ignore-scripts','--no-package-lock','--no-audit','--no-fund',*archives,'esbuild@0.28.2'],work)
 shutil.copyfile(ROOT/'vendor/ouroboros-chat-source.js',work/'chat-source.js')
 (work/'entry.js').write_text("import { marked, Marked } from 'marked';\nimport { parseFragment } from 'parse5';\nimport { prepareMarkdownSource, protectLatexDelimiters, renderImageReference } from './chat-source.js';\nexport function markdownTree(text) { return parseFragment(marked.parse(text, { gfm: true, breaks: false, async: false })); }\nconst chatParser = new Marked({ gfm: true, breaks: true, renderer: { image: renderImageReference } });\nexport function chatMarkdownTree(text) {\n  const { source, lessThan, escapedLessThan } = prepareMarkdownSource(text);\n  const authorText = value => String(value).split(escapedLessThan).join(`\\\\${lessThan}`);\n  const latex = protectLatexDelimiters(source, chatParser, authorText);\n  const tree = parseFragment(latex.restore(chatParser.parse(latex.protectedSource, { async: false })));\n  const pending = [[tree, false]];\n  while (pending.length) {\n    const [node, inCode] = pending.pop();\n    if (inCode && node.nodeName === '#text') node.value = authorText(node.value).split(lessThan).join('<');\n    for (const child of node.childNodes || []) pending.push([child, inCode || node.tagName === 'code']);\n  }\n  return tree;\n}\n")
 run([str(work/'node_modules/.bin/esbuild'),'entry.js','--bundle','--platform=browser','--format=esm','--target=es2022','--legal-comments=inline','--outfile=markdown-parser.js'],work)
 target=ROOT/'src/gjs/vendor/markdown-parser.js';target.write_text('// Generated from marked 18.0.7, parse5 8.1.1 and entities 9.0.0 using esbuild 0.28.2.\n// Licenses and reproduction: repository vendor/README.md.\n'+(work/'markdown-parser.js').read_text())
 for name in packages:
  folder=work/'node_modules'/name
  source=next(p for p in [folder/'LICENSE',folder/'LICENSE.md',folder/'LICENSE.txt'] if p.exists())
  shutil.copyfile(source,ROOT/'vendor'/(name+'.LICENSE'))
 print('bundle bytes',target.stat().st_size,'SHA256',hashlib.sha256(target.read_bytes()).hexdigest())
