#!/usr/bin/env python3
"""Copy the exact Mermaid distribution reviewed in the pinned gateway."""
from pathlib import Path
from urllib.request import urlopen
import hashlib
ROOT=Path(__file__).resolve().parents[1]
REVISION='15cacd32310868934da44d3c5c6b68ccb6cf458a'
FILES=[('web/mermaid.min.js','vendor/mermaid-browser.js','18327bef70d96fb505fe7287d9f6a7362ebf07ff6576ddfaffb1a06f3e1a2954'),('web/vendor/licenses/mermaid-LICENSE','vendor/mermaid.LICENSE','ec9fb67dcb25eccc416ed56e1aab819222c805a2a4bfe4cb19e7556bf2ffde80')]
for source,target,expected in FILES:
 with urlopen('https://raw.githubusercontent.com/razzant/ouroboros/'+REVISION+'/'+source) as response:data=response.read()
 actual=hashlib.sha256(data).hexdigest()
 if actual!=expected:raise SystemExit('Unexpected source hash: '+source)
 (ROOT/target).write_bytes(data);print(target,len(data),actual)
