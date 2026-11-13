#!/usr/bin/env python3
"""Rebuild the pinned, standalone Highlight.js language detector."""
import base64
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = "11.11.1"
ESBUILD = "0.28.2"
INTEGRITY = "sha512-Xwwo44whKBVCYoliBQwaPvtd/2tYFkRQtXDWj1nackaV2JPXx3L0+Jvd8/qCJ2p+ML0/XVkJ2q+Mr+UVdpJK5w=="


def run(args, cwd):
    return subprocess.run(args, cwd=cwd, check=True, text=True, capture_output=True).stdout


with tempfile.TemporaryDirectory(prefix="ouroboros-code-detector-build-") as directory:
    work = Path(directory)
    packs = json.loads(run(["npm", "pack", "highlight.js@" + VERSION, "--json"], work))
    package = packs[0] if isinstance(packs, list) else packs["highlight.js"]
    archive = work / package["filename"]
    actual = "sha512-" + base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode()
    if actual != INTEGRITY or package["integrity"] != INTEGRITY:
        raise SystemExit("Highlight.js archive integrity mismatch")
    run(["npm", "install", "--prefix", directory, "--ignore-scripts", "--no-package-lock", "--no-audit", "--no-fund",
         str(archive), "esbuild@" + ESBUILD], work)
    (work / "entry.js").write_text('''import hljs from 'highlight.js/lib/common';
export function detectCodeLanguage(source) { return hljs.highlightAuto(source, hljs.listLanguages().sort()).language; }
export function detectorLanguages() { return hljs.listLanguages().sort(); }
''')
    run([str(work / "node_modules/.bin/esbuild"), "entry.js", "--bundle", "--platform=browser", "--format=esm",
         "--target=es2022", "--legal-comments=inline", "--outfile=code-detector.js"], work)
    target = ROOT / "src/gjs/vendor/code-detector.js"
    target.write_text("// Generated from highlight.js 11.11.1 (common) using esbuild 0.28.2.\n"
                      "// BSD-3-Clause license and reproduction: repository vendor/README.md.\n" + (work / "code-detector.js").read_text())
    shutil.copyfile(work / "node_modules/highlight.js/LICENSE", ROOT / "vendor/highlight.js.LICENSE")
    print("bundle bytes", target.stat().st_size, "SHA256", hashlib.sha256(target.read_bytes()).hexdigest())
