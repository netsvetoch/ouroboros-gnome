#!/usr/bin/env python3
"""Build the small native GIO stream needed by WebKit's worker-thread reader."""
import os, pathlib, shlex, subprocess
root=pathlib.Path(__file__).resolve().parents[1]
out=root/'dist-gjs/native';out.mkdir(parents=True,exist_ok=True)
source=root/'src/native'
flags=shlex.split(subprocess.check_output(['pkg-config','--cflags','--libs','gio-2.0'],text=True))
subprocess.run([os.environ.get('CC','cc'),'-shared','-fPIC','-O2','-Wall','-Wextra','-Werror','-o',str(out/'libouroboros-stream.so'),str(source/'stream.c'),*flags],check=True)
subprocess.run(['g-ir-scanner','--quiet','--warn-all','--warn-error','--namespace=OuroborosStream','--nsversion=1.0','--identifier-prefix=Ouroboros','--symbol-prefix=ouroboros','--include=Gio-2.0','--pkg=gio-2.0','--library=ouroboros-stream','--library-path='+str(out),'--output='+str(out/'OuroborosStream-1.0.gir'),str(source/'stream.h'),str(source/'stream.c')],check=True)
subprocess.run(['g-ir-compiler',str(out/'OuroborosStream-1.0.gir'),'--output='+str(out/'OuroborosStream-1.0.typelib')],check=True)
