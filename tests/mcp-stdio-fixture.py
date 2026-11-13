"""Owned SDK stdio server: record exact argv and list inert tools; never call it."""
import asyncio
import json
import pathlib
import sys
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server
import mcp.types as types

received=sys.argv[2:]
pathlib.Path(sys.argv[1]).write_text(json.dumps(received,ensure_ascii=False))
server=Server('native-argv-fixture')
@server.list_tools()
async def tools(request:types.ListToolsRequest):
    return types.ListToolsResult(tools=[types.Tool(name='argv_fixture',description=json.dumps(received,ensure_ascii=False),inputSchema={'type':'object','properties':{}}),types.Tool(name='with,comma',description='Raw comma name',inputSchema={'type':'object','properties':{}}),types.Tool(name='unselected',description='Not selected',inputSchema={'type':'object','properties':{}})])
async def main():
    async with stdio_server() as (read,write):
        await server.run(read,write,server.create_initialization_options())
asyncio.run(main())
