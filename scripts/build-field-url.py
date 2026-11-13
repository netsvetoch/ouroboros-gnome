#!/usr/bin/env python3
"""Rebuild the committed, self-contained URL parser; normal builds need no npm packages."""
import hashlib
import base64
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = "3.51.0"
ESBUILD = "0.28.2"
INTEGRITY = "sha512-NE4SFDJ+qzQeqHG2vVSNwopzS6zZNPYJ5kinIqs+OofTqGzOmICgT89E/yvS9XY7rwb3eU1utWXTJ9nVFqv74A=="
HEADER = ("// Generated from core-js-pure 3.51.0 using esbuild 0.28.2.\n"
          "// Source and MIT license: see vendor/README.md and vendor/core-js-pure.LICENSE.\n")


def run(args, cwd):
    return subprocess.run(args, cwd=cwd, check=True, text=True, capture_output=True).stdout


with tempfile.TemporaryDirectory(prefix="ouroboros-field-url-build-") as directory:
    work = Path(directory)
    packages = json.loads(run(["npm", "pack", f"core-js-pure@{VERSION}", "--json"], work))
    package = packages[0] if isinstance(packages, list) else packages["core-js-pure"]
    archive = work / package["filename"]
    actual = "sha512-" + base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode()
    if package["integrity"] != INTEGRITY or actual != INTEGRITY:
        raise SystemExit("core-js-pure archive integrity differs from the reviewed version")
    run(["npm", "install", "--prefix", directory, "--ignore-scripts", "--no-package-lock",
         "--no-audit", "--no-fund", str(work / package["filename"]), f"esbuild@{ESBUILD}"], work)
    (work / "entry.js").write_text("import FieldURL from 'core-js-pure/actual/url/index.js';\nexport { FieldURL };\n")
    run([str(work / "node_modules/.bin/esbuild"), "entry.js", "--bundle", "--platform=browser",
         "--format=esm", "--target=es2022", "--legal-comments=inline", "--outfile=url-parser.js"], work)
    target = ROOT / "src/gjs/vendor/field-url.js"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(HEADER + (work / "url-parser.js").read_text())
    license_path = ROOT / "vendor/core-js-pure.LICENSE"
    license_path.parent.mkdir(exist_ok=True)
    shutil.copyfile(work / "node_modules/core-js-pure/LICENSE", license_path)
    print(f"{target.relative_to(ROOT)} · SHA-256 {hashlib.sha256(target.read_bytes()).hexdigest()}")
