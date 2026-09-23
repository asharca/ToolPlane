#!/usr/bin/env node
// Run from the ToolPlane repository after installing its pinned dependencies.
// This calls only initialize, tools/list and (when permitted) sandbox_info.
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const require=createRequire(path.join(process.cwd(),'package.json'));
const {Client}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
const {StreamableHTTPClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')).href);
const url=new URL(process.env.TOOLPLANE_SANDBOX_MCP_URL);
if(url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw new Error('Use HTTPS outside localhost.');
const token=process.env.TOOLPLANE_SANDBOX_TOKEN;
if(!/^mcpsbx_[a-f0-9]{64}$/.test(token??''))throw new Error('A scoped sandbox MCP token is required.');
const client=new Client({name:'toolplane-sandbox-smoke',version:'1.0.0'});
try {
  await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{authorization:`Bearer ${token}`}}}));
  const catalog=await client.listTools();
  console.log(JSON.stringify({tools:catalog.tools.map(({name})=>name)},null,2));
  if(catalog.tools.some(({name})=>name==='sandbox_info')) {
    const result=await client.callTool({name:'sandbox_info',arguments:{}});
    console.log(JSON.stringify(result,null,2));
    if(result.isError)process.exitCode=1;
  }
} finally {await client.close();}
