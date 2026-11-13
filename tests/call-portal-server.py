"""Isolated xdg portal protocol fixture; /dev/null FD, no PipeWire or capture."""
import json,os,pathlib,sys,traceback
from gi.repository import Gio,GLib
root='/org/freedesktop/portal/desktop'
xml='''<node>
<interface name="org.freedesktop.portal.ScreenCast">
<property name="version" type="u" access="read"/>
<property name="AvailableSourceTypes" type="u" access="read"/>
<property name="AvailableCursorModes" type="u" access="read"/>
<method name="CreateSession"><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
<method name="SelectSources"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
<method name="Start"><arg type="o" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
<method name="OpenPipeWireRemote"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="h" direction="out"/></method>
</interface>
<interface name="org.freedesktop.portal.Camera">
<property name="version" type="u" access="read"/><property name="IsCameraPresent" type="b" access="read"/>
<method name="AccessCamera"><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
<method name="OpenPipeWireRemote"><arg type="a{sv}" direction="in"/><arg type="h" direction="out"/></method>
</interface>
<interface name="org.ouroboros.PortalFixture">
<method name="Configure"><arg type="s" direction="in"/></method>
<method name="Facts"><arg type="s" direction="out"/></method>
<method name="EmitClosed"><arg type="o" direction="in"/></method>
</interface></node>'''
request_info=Gio.DBusNodeInfo.new_for_xml('<node><interface name="org.freedesktop.portal.Request"><method name="Close"/><signal name="Response"><arg type="u"/><arg type="a{sv}"/></signal></interface></node>').interfaces[0]
session_info=Gio.DBusNodeInfo.new_for_xml('<node><interface name="org.freedesktop.portal.Session"><method name="Close"/><signal name="Closed"><arg type="a{sv}"/></signal></interface></node>').interfaces[0]
audit=[];pending={};sessions={};config={'camera':True,'hold':'','response':0,'streams':True,'serial':12345};conn=None

def record(method,path,args):audit.append({'method':method,'path':path,'args':args})
def response(path,code=None,results=None):
    row=pending.pop(path,None)
    if row is not None:conn.emit_signal(row['sender'],path,'org.freedesktop.portal.Request','Response',GLib.Variant('(ua{sv})',(row['response'] if code is None else code,row['results'] if results is None else results)))
    return GLib.SOURCE_REMOVE

def request(sender,method,options,inv,results):
    token=options['handle_token'];path='/org/freedesktop/portal/desktop/request/'+sender[1:].replace('.','_')+'/'+token
    conn.register_object(path,request_info,handle,None,None)
    pending[path]={'method':method,'sender':sender,'response':config['response'],'results':results}
    inv.return_value(GLib.Variant('(o)',(path,)))
    if config['hold']!=method:GLib.timeout_add(30,response,path)

def handle(connection,sender,path,interface,method,params,inv):
    try:
        args=params.unpack()
        if interface=='org.ouroboros.PortalFixture':
            if method=='Configure':config.update(json.loads(args[0]));inv.return_value(None)
            elif method=='Facts':inv.return_value(GLib.Variant('(s)',(json.dumps({'audit':audit,'pending':[{'path':p,'method':r['method']} for p,r in pending.items()],'sessions':sessions}),)))
            elif method=='EmitClosed':conn.emit_signal(sessions[args[0]]['sender'],args[0],'org.freedesktop.portal.Session','Closed',GLib.Variant('(a{sv})',({},)));inv.return_value(None)
            return
        record(method,path,args)
        if interface=='org.freedesktop.portal.Request':
            inv.return_value(None);response(path,1,{});return
        if interface=='org.freedesktop.portal.Session':
            sessions[path]['closed']+=1;inv.return_value(None);return
        if method=='OpenPipeWireRemote':
            fd=os.open('/dev/null',os.O_RDONLY);fds=Gio.UnixFDList.new()
            try:index=fds.append(fd);inv.return_value_with_unix_fd_list(GLib.Variant('(h)',(index,)),fds)
            finally:os.close(fd)
            return
        options=args[-1];result={}
        if method=='CreateSession':
            session='/org/freedesktop/portal/desktop/session/'+sender[1:].replace('.','_')+'/'+options['session_handle_token']
            conn.register_object(session,session_info,handle,None,None);sessions[session]={'closed':0,'sender':sender};result={'session_handle':GLib.Variant('o',session)}
        elif method=='Start':
            streams=[(71,{'source_type':GLib.Variant('u',1),'pipewire-serial':GLib.Variant('t',config['serial'])})] if config['streams'] else []
            result={'streams':GLib.Variant('a(ua{sv})',streams),'persist_mode':GLib.Variant('u',0)}
        request(sender,method,options,inv,result)
    except Exception:
        traceback.print_exc();inv.return_dbus_error('org.ouroboros.FixtureError','fixture exception')

def prop(connection,sender,path,interface,name):
    if name=='IsCameraPresent':return GLib.Variant('b',config['camera'])
    return GLib.Variant('u',{'version':4,'AvailableSourceTypes':3,'AvailableCursorModes':7}[name])

def acquired(connection,name):
    global conn
    conn=connection
    for interface in Gio.DBusNodeInfo.new_for_xml(xml).interfaces:conn.register_object(root,interface,handle,prop,None)

def ready(connection,name):pathlib.Path(sys.argv[1],'ready').write_text('ready')
Gio.bus_own_name(Gio.BusType.SESSION,'org.freedesktop.portal.Desktop',Gio.BusNameOwnerFlags.NONE,acquired,ready,None)
GLib.MainLoop().run()
