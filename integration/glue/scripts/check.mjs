import {existsSync,readFileSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {assertUnlinked} from '../runtime/storage.js';
import {readConfigurationText,parseConfiguration,parseJsonConfiguration,assertLocalConnection} from './configuration.mjs';
import {collectFiles,fingerprint} from './installation-files.mjs';
const installation=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const workspace=realpathSync(resolve(installation,'../../..'));
try {
 const identity=JSON.parse(readFileSync(join(installation,'installation.json'),'utf8'));
 const actual=collectFiles(installation);
 if(identity.format!==1||fingerprint(identity.files)!==identity.packageId||fingerprint(actual)!==identity.packageId)throw Error('Installed package differs from its recorded build.');
 const binding=existsSync(join(installation,'connection.json'))?JSON.parse(readFileSync(join(installation,'connection.json'),'utf8')):{format:1,host:'codex',name:'glue',config:join(workspace,'.codex/config.toml')};
 if(binding.format!==1||!['codex','claude-code','claude-desktop'].includes(binding.host)||typeof binding.name!=='string'||typeof binding.config!=='string')throw Error('Invalid installed host binding.');
 for(const file of ['SKILL.md',...(binding.host==='codex'?['agents/openai.yaml']:[]),'references/maintenance.md','runtime/handoff.js','runtime/mcp.js','runtime/recovery.js','runtime/storage.js','runtime/input.js','runtime/package.json','runtime/node_modules/zod/package.json']){
  const path=join(installation,file);assertUnlinked(path);if(!existsSync(path))throw Error('Missing installed file: '+file);
 }
 const config=isAbsolute(binding.config)?binding.config:join(workspace,binding.config);assertUnlinked(config);
 const parsed=binding.host==='codex'?parseConfiguration(readConfigurationText(config)):parseJsonConfiguration(readConfigurationText(config));
 const args=[join(installation,'runtime/mcp.js'),workspace];
 assertLocalConnection(parsed,process.execPath,args,binding.host,binding.name);
 const input=[
  {jsonrpc:'2.0',id:0,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'glue-check',version:'1.0'}}},
  {jsonrpc:'2.0',method:'notifications/initialized'},
  {jsonrpc:'2.0',id:1,method:'tools/list'},
 ].map(value=>JSON.stringify(value)).join('\n')+'\n';
 const child=spawnSync(process.execPath,args,{input,encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:1024*1024});
 if(child.error)throw child.error;if(child.status!==0)throw Error(child.stderr);
 const responses=child.stdout.trim().split('\n').map(line=>JSON.parse(line));
 const initialized=responses.find(response=>response.id===0);
 if(initialized?.error||initialized?.result?.protocolVersion!=='2025-11-25'||initialized?.result?.serverInfo?.version!==identity.version)throw Error('MCP initialization or product version verification failed.');
 const tools=responses.find(response=>response.id===1)?.result?.tools?.map(t=>t.name);
 if(!Array.isArray(tools))throw Error('MCP discovery failed.');
 assertLocalConnection(parsed,process.execPath,args,binding.host,binding.name,tools);
 if(JSON.stringify(tools)!==JSON.stringify(['glue_resume','glue_checkpoint','glue_find','glue_read','glue_check_capture','glue_transfer']))throw Error('Unexpected MCP tools.');
 console.log(JSON.stringify({ok:true,workspace,host:binding.host,serverName:binding.name,tools,version:identity.version,sourceId:identity.sourceId,packageId:identity.packageId,mode:identity.mode,nativeLoadingVerified:false}));
} catch(error){console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;}
