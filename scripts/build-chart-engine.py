#!/usr/bin/env python3
"""Rebuild the pinned, standalone Chart.js engine."""
import base64
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = "4.4.8"
ESBUILD = "0.28.2"
INTEGRITY = "sha512-IkGZlVpXP+83QpMm4uxEiGqSI7jFizwVtF3+n5Pc3k7sMO+tkd0qxh2OzLhenM0K80xtmAONWGBn082EiBQSDA=="


def run(args, cwd):
    return subprocess.run(args, cwd=cwd, check=True, text=True, capture_output=True).stdout


with tempfile.TemporaryDirectory(prefix="ouroboros-chart-engine-build-") as directory:
    work = Path(directory)
    packs = json.loads(run(["npm", "pack", "chart.js@" + VERSION, "--json"], work))
    package = packs[0] if isinstance(packs, list) else packs["chart.js"]
    archive = work / package["filename"]
    actual = "sha512-" + base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode()
    if actual != INTEGRITY or package["integrity"] != INTEGRITY:
        raise SystemExit("Chart.js archive integrity mismatch")
    color_packs = json.loads(run(["npm", "pack", "@kurkle/color@0.3.4", "--json"], work))
    color_package = color_packs[0] if isinstance(color_packs, list) else color_packs["@kurkle/color"]
    color_archive = work / color_package["filename"]
    expected = "sha512-M5UknZPHRu3DEDWoipU6sE8PdkZ6Z/S+v4dD+Ke8IaNlpdSQah50lz1KtcFBa2vsdOnwbbnxJwVM4wty6udA5w=="
    actual = "sha512-" + base64.b64encode(hashlib.sha512(color_archive.read_bytes()).digest()).decode()
    if color_package["integrity"] != expected or actual != expected:
        raise SystemExit("@kurkle/color archive integrity mismatch")
    run(["npm", "install", "--prefix", directory, "--ignore-scripts", "--no-package-lock", "--no-audit", "--no-fund",
         str(archive), str(color_archive), "esbuild@" + ESBUILD], work)
    (work / "entry.js").write_text("import { Chart, registerables, BasicPlatform } from 'chart.js';\nChart.register(...registerables);\nexport { Chart, BasicPlatform };\n")
    run([str(work / "node_modules/.bin/esbuild"), "entry.js", "--bundle", "--platform=browser", "--format=esm",
         "--target=es2022", "--legal-comments=inline", "--outfile=chart-engine.js"], work)
    target = ROOT / "src/gjs/vendor/chart-engine.js"
    target.write_text("// Generated from chart.js 4.4.8 and @kurkle/color 0.3.4 using esbuild 0.28.2.\n"
                      "// MIT licenses and reproduction: repository vendor/README.md.\n" + (work / "chart-engine.js").read_text())
    shutil.copyfile(work / "node_modules/chart.js/LICENSE.md", ROOT / "vendor/chart.js.LICENSE")
    shutil.copyfile(work / "node_modules/@kurkle/color/LICENSE.md", ROOT / "vendor/kurkle-color.LICENSE")
    print("bundle bytes", target.stat().st_size, "SHA256", hashlib.sha256(target.read_bytes()).hexdigest())
