import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,existsSync,unlinkSync,readdirSync,symlinkSync,rmSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {Handoffs,hash} from '../dist/handoff.js';
import {Knowledge} from '../dist/knowledge.js';
import {collectFiles} from '../scripts/installation-files.mjs';

const protocolStart = [
 {jsonrpc:'2.0',id:'test-initialize',method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'glue-test',version:'1'}}},
 {jsonrpc:'2.0',method:'notifications/initialized'},
].map(value=>JSON.stringify(value)+'\n').join('');
function mcpRun(workspace,options){
 const input=Buffer.concat([Buffer.from(protocolStart),Buffer.isBuffer(options.input)?options.input:Buffer.from(options.input)]);
 const child=spawnSync(process.execPath,['dist/mcp.js',workspace],{...options,input,windowsHide:true});
 child.stdout=(child.stdout??'').split('\n').filter(line=>line && JSON.parse(line).id!=='test-initialize').join('\n');
 return child;
}

function fixture(t){const workspace=mkdtempSync(join(tmpdir(),'glue-handoff-test-'));t.after(()=>rmSync(workspace,{recursive:true,force:true}));return {workspace,store:new Handoffs(workspace)};}
function failRename(t,target){
 const original=fs.renameSync;
 fs.renameSync=(from,to)=>{if(to===target)throw new Error('Injected rename failure');return original(from,to);};
 syncBuiltinESMExports();
 const restore=()=>{fs.renameSync=original;syncBuiltinESMExports();};t.after(restore);return restore;
}
const first=(markdown='# Context\nOriginal user decision.')=>({context:'notes/handoff.md',expectedVersion:null,markdown,evidence:[]});
test('resume is read-only; one checkpoint binds no sessions and preserves exact Unicode Markdown',t=>{
 const {store,workspace}=fixture(t);assert.equal(store.resume({context:'notes/handoff.md'}).version,null);assert.equal(existsSync(join(workspace,'.glue')),false);
 const request=first('# 计划\n  Exact user wording 🙂\n'),r=store.save(request);
 assert.equal(r.committed,true);assert.equal(r.workingCopyUpdated,true);
 assert.equal(store.resume({context:'notes/handoff.md'}).markdown,'# 计划\n  Exact user wording 🙂\n');
 assert.equal(readFileSync(join(workspace,'notes/handoff.md'),'utf8'),'# 计划\n  Exact user wording 🙂\n');
 const replay=store.save(request);
 assert.equal(replay.committed,true);assert.equal(replay.replayed,true);assert.equal(replay.workingCopyUpdated,false);
 assert.equal(replay.version,r.version);assert.equal('next' in replay,false);
 assert.equal(store.resume({context:request.context}).workingCopy.status,'matches');
 assert.equal(readdirSync(join(store.location(request.context).directory,'revisions')).length,1);
});
test('evidence freshness, exact old bytes, missing files and explicit deselection',t=>{
 const {workspace,store}=fixture(t);writeFileSync(join(workspace,'source.txt'),'original\r\n');
 const a=store.save({...first(),evidence:['source.txt']});writeFileSync(join(workspace,'source.txt'),'changed');
 let view=store.resume({context:'notes/handoff.md'});assert.equal(view.evidence[0].status,'changed');assert.equal(readFileSync(view.evidence[0].snapshot,'utf8'),'original\r\n');
 assert.equal(view.evidence[0].savedHash,hash('original\r\n'));assert.equal(view.evidence[0].currentHash,hash('changed'));
 assert.throws(()=>store.save({context:'notes/handoff.md',expectedVersion:a.version,markdown:'Unrelated progress'}),/Evidence changed: source.txt/);
 assert.equal(store.head('notes/handoff.md').version,a.version);
 const b=store.save({context:'notes/handoff.md',expectedVersion:a.version,markdown:'Explicit correction; unrelated constraints retained.',reviewedEvidence:[{path:'source.txt',hash:view.evidence[0].currentHash}]});
 assert.equal(store.resume({context:'notes/handoff.md'}).evidence[0].status,'unchanged');
 assert.equal(store.revision(store.location('notes/handoff.md').directory,a.version).markdown,first().markdown);
 unlinkSync(join(workspace,'source.txt'));assert.equal(store.resume({context:'notes/handoff.md'}).evidence[0].status,'missing');
 assert.throws(()=>store.save({context:'notes/handoff.md',expectedVersion:b.version,markdown:'must fail'}));
 assert.equal(store.head('notes/handoff.md').version,b.version);
 store.save({context:'notes/handoff.md',expectedVersion:b.version,markdown:'Source retired explicitly.',evidence:[]});
 assert.equal(store.resume({context:'notes/handoff.md'}).evidence.length,0);
});
test('evidence review rejects a second edit atomically and exact retries retain the accepted snapshot',t=>{
 const {workspace,store}=fixture(t);writeFileSync(join(workspace,'s.txt'),'one');
 const a=store.save({...first(),evidence:['s.txt']});writeFileSync(join(workspace,'s.txt'),'two');
 const observed=store.resume({context:'notes/handoff.md'}).evidence[0].currentHash;
 const request={context:'notes/handoff.md',expectedVersion:a.version,markdown:'Reviewed two',evidence:['s.txt'],reviewedEvidence:[{path:'s.txt',hash:observed}]};
 writeFileSync(join(workspace,'s.txt'),'three');assert.throws(()=>store.save(request),/changed since review/);
 assert.equal(store.head(request.context).version,a.version);assert.equal(readFileSync(join(workspace,request.context),'utf8'),first().markdown);
 writeFileSync(join(workspace,'s.txt'),'two');const b=store.save(request);
 writeFileSync(join(workspace,'s.txt'),'four');assert.equal(store.save(request).version,b.version);
 const view=store.resume({context:request.context});assert.equal(view.evidence[0].status,'changed');assert.equal(readFileSync(view.evidence[0].snapshot,'utf8'),'two');
 assert.throws(()=>store.save({...request,expectedVersion:b.version,evidence:[]}),/selected evidence/);
 assert.throws(()=>store.save({...request,expectedVersion:b.version,reviewedEvidence:[request.reviewedEvidence[0],request.reviewedEvidence[0]]}),/at most once/);
});
test('retry after intervening commit does not duplicate or overwrite; stale writes fail',t=>{
 const {store}=fixture(t),request=first(),a=store.save(request);
 const b=store.save({context:request.context,expectedVersion:a.version,markdown:'Second checkpoint',evidence:[]});
 const replay=store.save(request);assert.equal(replay.version,a.version);assert.equal(replay.replayed,true);assert.equal(replay.currentVersion,b.version);
 assert.equal(replay.workingCopyUpdated,false);assert.equal(store.resume({context:request.context}).workingCopy.status,'matches');
 assert.throws(()=>store.save({...request,markdown:'stale alternative'}),/Version conflict/);
 assert.equal(store.resume({context:request.context}).markdown,'Second checkpoint');
});

test('fresh saves read only HEAD and remain available with a corrupt older revision',t=>{
 const {store}=fixture(t),request=first(),a=store.save(request);
 const b=store.save({...request,expectedVersion:a.version,markdown:'Healthy current revision'}),loc=store.location(request.context);
 writeFileSync(join(loc.directory,'revisions',a.version+'.json'),'corrupt older revision');
 const original=store.revision.bind(store),reads=[];
 store.revision=(directory,version)=>{reads.push(version);return original(directory,version);};
 const c=store.save({...request,expectedVersion:b.version,markdown:'New work'});
 assert.equal(c.committed,true);assert.equal(c.replayed,false);assert.deepEqual(reads,[b.version]);
 const inspection=store.inspect(request.context);
 assert.equal(inspection.revisions.find(r=>r.version===a.version).valid,false);
 assert.equal(inspection.revisions.find(r=>r.version===c.version).valid,true);
 assert.throws(()=>store.save(request),/integrity/);
 assert.equal(store.head(request.context).version,c.version);
 writeFileSync(join(loc.directory,'revisions',c.version+'.json'),'corrupt current revision');
 assert.throws(()=>store.save({...request,expectedVersion:c.version,markdown:'Must not ignore damaged HEAD'}),/integrity/);
});

test('retry lookup after recovery only accepts revisions in committed ancestry',t=>{
 const {store}=fixture(t),request=first(),a=store.save(request);
 const second={...request,expectedVersion:a.version,markdown:'Second revision'},b=store.save(second);
 const third={...request,expectedVersion:b.version,markdown:'Third revision'};store.save(third);
 const inspection=store.inspect(request.context);
 store.restore(request.context,a.version,inspection.headHash,inspection.workingCopyHash);
 assert.throws(()=>store.save(third),/Version conflict/);
 assert.equal(store.head(request.context).version,a.version);
 const reapplied=store.save(second);
 assert.equal(reapplied.committed,true);assert.equal(reapplied.replayed,false);
 assert.equal(store.resume({context:request.context}).markdown,second.markdown);
});

test('committed retries use saved evidence even when live sources become linked',t=>{
 const {workspace,store}=fixture(t);mkdirSync(join(workspace,'sources'));writeFileSync(join(workspace,'sources/source.txt'),'saved evidence');
 const request={...first(),evidence:['sources/source.txt']},a=store.save(request);
 const snapshot=store.resume({context:request.context}).evidence[0].snapshot;
 const b=store.save({...request,expectedVersion:a.version,markdown:'Later work',evidence:[]});
 renameSync(join(workspace,'sources'),join(workspace,'moved-sources'));
 symlinkSync(join(workspace,'moved-sources'),join(workspace,'sources'),'junction');
 const loc=store.location(request.context),headBefore=readFileSync(loc.head),filesBefore=readdirSync(join(loc.directory,'revisions'));
 const replay=store.save(request);
 assert.equal(replay.replayed,true);assert.equal(replay.version,a.version);assert.equal(replay.currentVersion,b.version);
 assert.deepEqual(readFileSync(loc.head),headBefore);assert.deepEqual(readdirSync(join(loc.directory,'revisions')),filesBefore);
 assert.equal(readFileSync(loc.file,'utf8'),'Later work');
 assert.throws(()=>store.save({...request,expectedVersion:b.version,markdown:'New capture'}),/linked/);
 writeFileSync(snapshot,'corrupt snapshot');assert.throws(()=>store.save(request),/integrity/);
 assert.deepEqual(readFileSync(loc.head),headBefore);
});

test('linked live evidence stays unavailable while intact snapshots remain resumable and recoverable',t=>{
 const {workspace,store}=fixture(t),request=first();mkdirSync(join(workspace,'sources'));
 writeFileSync(join(workspace,'sources/source.txt'),'original evidence');
 const saved=store.save({...request,evidence:['sources/source.txt']});
 renameSync(join(workspace,'sources'),join(workspace,'original-sources'));
 symlinkSync(join(workspace,'original-sources'),join(workspace,'sources'),'junction');
 writeFileSync(join(workspace,'original-sources/source.txt'),'current live bytes');
 const view=store.resume({context:request.context});
 assert.equal(view.version,saved.version);assert.equal(view.markdown,request.markdown);
 assert.equal(view.evidence[0].status,'unavailable');assert.equal(readFileSync(view.evidence[0].snapshot,'utf8'),'original evidence');
 const inspection=store.inspect(request.context);
 assert.equal(inspection.revisions.find(r=>r.version===saved.version).valid,true);
 assert.throws(()=>store.save({...request,expectedVersion:saved.version,markdown:'Must not capture linked source',evidence:['sources/source.txt']}),/linked/);
 assert.throws(()=>store.save({context:request.context,expectedVersion:saved.version,markdown:'Must not refresh linked source'}),/linked/);
 assert.equal(store.restore(request.context,saved.version,inspection.headHash,inspection.workingCopyHash).restored,true);
 assert.equal(readFileSync(join(workspace,'original-sources/source.txt'),'utf8'),'current live bytes');
 writeFileSync(view.evidence[0].snapshot,'corrupt snapshot');
 assert.throws(()=>store.resume({context:request.context}),/integrity/);
 assert.equal(store.inspect(request.context).revisions.find(r=>r.version===saved.version).valid,false);
});

test('snapshot validation still refuses unsafe recorded paths and linked snapshot storage',t=>{
 const {workspace,store}=fixture(t);writeFileSync(join(workspace,'source.txt'),'evidence');
 const request={...first(),evidence:['source.txt']},saved=store.save(request),loc=store.location(request.context);
 const evidence=store.revision(loc.directory,saved.version).evidence;
 for(const path of ['../outside.txt','.agents/secret.txt','CON.txt','source.txt:stream']) {
  assert.throws(()=>store.verifyEvidence(loc.directory,[{...evidence[0],path}]));
 }
 assert.throws(()=>store.verifyEvidence(loc.directory,[{...evidence[0],snapshot:'../outside.txt'}]),/snapshot path/);
 const moved=join(workspace,'moved-snapshots');renameSync(join(loc.directory,'evidence'),moved);
 symlinkSync(moved,join(loc.directory,'evidence'),'junction');
 assert.throws(()=>store.resume({context:request.context}),/linked/);
 const inspection=store.inspect(request.context);
 assert.equal(inspection.revisions.find(r=>r.version===saved.version).valid,false);
 assert.throws(()=>store.restore(request.context,saved.version,inspection.headHash,inspection.workingCopyHash),/linked/);
});
test('ordinary Markdown adoption and external edit reconciliation preserve prior manual bytes',t=>{
 const {workspace,store}=fixture(t);mkdirSync(join(workspace,'notes'));const file=join(workspace,'notes/handoff.md');writeFileSync(file,'Manual baseline');
 assert.throws(()=>store.save(first()),/Working copy changed/);
 const a=store.save({...first('Adopted with explicit reconciliation'),workingCopyHash:store.resume({context:'notes/handoff.md'}).workingCopy.hash});
 writeFileSync(file,'External correction');const read=store.resume({context:'notes/handoff.md'});assert.equal(read.workingCopy.status,'edited');
 assert.throws(()=>store.save({context:'notes/handoff.md',expectedVersion:a.version,markdown:'Lost edit'}),/Working copy/);
 const b=store.save({context:'notes/handoff.md',expectedVersion:a.version,workingCopyHash:read.workingCopy.hash,markdown:'Reconciled external correction'});
 assert.equal(store.revision(store.location('notes/handoff.md').directory,b.version).workingCopyBefore,'External correction');
});
test('a changed observed working hash blocks reconciliation',t=>{
 const {workspace,store}=fixture(t);const a=store.save(first());writeFileSync(join(workspace,'notes/handoff.md'),'one');const token=store.resume({context:'notes/handoff.md'}).workingCopy.hash;
 writeFileSync(join(workspace,'notes/handoff.md'),'two');assert.throws(()=>store.save({context:'notes/handoff.md',expectedVersion:a.version,markdown:'combined',workingCopyHash:token}),/Working copy/);
 assert.equal(readFileSync(join(workspace,'notes/handoff.md'),'utf8'),'two');
});

test('damaged working copies do not hide saved state or allow writes',t=>{
 for(const damaged of [Buffer.from([0xff,0xfe,0x61]),Buffer.alloc(131073,120)]){
  const {workspace,store}=fixture(t),request=first(),saved=store.save(request),loc=store.location(request.context);
  writeFileSync(loc.file,damaged);
  const headBefore=readFileSync(loc.head),revisionNames=readdirSync(join(loc.directory,'revisions'));
  const view=store.resume({context:request.context});
  assert.equal(view.version,saved.version);assert.equal(view.markdown,request.markdown);
  assert.equal(view.workingCopy.status,'unavailable');assert.equal('hash' in view.workingCopy,false);
  assert.match(view.workingCopy.error,/encoding|size limit/);
  const inspection=store.inspect(request.context);
  assert.equal(inspection.revisions.find(r=>r.version===saved.version).valid,true);
  assert.equal(inspection.workingCopy.status,'unavailable');assert.equal('workingCopyHash' in inspection,false);
  assert.throws(()=>store.save({...request,expectedVersion:saved.version,markdown:'Must not overwrite',workingCopyHash:null}));
  assert.throws(()=>store.restore(request.context,saved.version,inspection.headHash,null));
  assert.deepEqual(readFileSync(loc.file),damaged);assert.deepEqual(readFileSync(loc.head),headBefore);
  assert.deepEqual(readdirSync(join(loc.directory,'revisions')),revisionNames);
  assert.equal(readdirSync(loc.directory).some(name=>name.startsWith('recovery-')),false);
  // Preserving the external bytes and explicitly removing the damaged projection permits recovery.
  writeFileSync(join(workspace,'preserved-working-copy.bin'),damaged);unlinkSync(loc.file);
  const missing=store.inspect(request.context);assert.equal(missing.workingCopyHash,null);
  assert.equal(store.restore(request.context,saved.version,missing.headHash,missing.workingCopyHash).workingCopyUpdated,true);
  assert.deepEqual(readFileSync(join(workspace,'preserved-working-copy.bin')),damaged);
  assert.equal(store.resume({context:request.context}).workingCopy.status,'matches');
 }
});

test('working-copy errors do not conceal corrupt saved revisions or evidence',t=>{
 const {workspace,store}=fixture(t);writeFileSync(join(workspace,'source.txt'),'evidence');
 const request={...first(),evidence:['source.txt']},saved=store.save(request),loc=store.location(request.context);
 const snapshot=store.resume({context:request.context}).evidence[0].snapshot;
 writeFileSync(loc.file,Buffer.from([255]));writeFileSync(snapshot,'tampered');
 assert.throws(()=>store.resume({context:request.context}),/integrity/);
 assert.equal(store.inspect(request.context).revisions.find(r=>r.version===saved.version).valid,false);
 writeFileSync(join(loc.directory,'revisions',saved.version+'.json'),'{}');
 assert.throws(()=>store.resume({context:request.context}),/integrity/);
});

test('MCP resume and recovery CLI inspection return saved history with an unreadable working copy',t=>{
 const {workspace,store}=fixture(t),request=first(),saved=store.save(request);
 writeFileSync(join(workspace,request.context),Buffer.from([255]));
 const call={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'glue_resume',arguments:{context:request.context}}};
 const mcp=mcpRun(workspace,{input:JSON.stringify(call)+'\n',encoding:'utf8',windowsHide:true});
 assert.equal(mcp.status,0,mcp.stderr);const result=JSON.parse(mcp.stdout).result;
 assert.notEqual(result.isError,true);const view=JSON.parse(result.content[0].text);
 assert.equal(view.markdown,request.markdown);assert.equal(view.workingCopy.status,'unavailable');
 const cli=spawnSync(process.execPath,['dist/recovery.js',workspace,'-'],{input:JSON.stringify({action:'inspect',context:request.context}),encoding:'utf8',windowsHide:true});
 assert.equal(cli.status,0,cli.stderr);const inspection=JSON.parse(cli.stdout);
 assert.equal(inspection.revisions.find(r=>r.version===saved.version).valid,true);
 assert.equal(inspection.workingCopy.status,'unavailable');assert.equal('workingCopyHash' in inspection,false);
});
test('a failed Markdown projection reports committed data honestly and can be reconciled',t=>{
 const {workspace,store}=fixture(t);const restoreRename=failRename(t,join(workspace,'notes/handoff.md'));
 const request=first(),a=store.save(request);assert.equal(a.committed,true);assert.equal(a.replayed,false);assert.equal(a.workingCopyUpdated,false);
 assert.match(a.next,/Resume and reconcile/);
 const replay=store.save(request);assert.equal(replay.committed,true);assert.equal(replay.replayed,true);assert.equal(replay.workingCopyUpdated,false);
 assert.equal(replay.version,a.version);assert.equal(store.resume({context:request.context}).workingCopy.status,'missing');
 assert.equal(store.resume({context:'notes/handoff.md'}).markdown,first().markdown);
 restoreRename();
 const b=store.save({context:'notes/handoff.md',expectedVersion:a.version,markdown:first().markdown,workingCopyHash:null});assert.equal(b.workingCopyUpdated,true);
});
test('save preserves an intervening edit after committing history',t=>{
 const {store}=fixture(t),request=first(),saved=store.save(request),loc=store.location(request.context);
 const working=store.working.bind(store);let reads=0;
 store.working=file=>{
  if(++reads===2){assert.notEqual(store.head(request.context).version,saved.version);writeFileSync(file,'External edit during save');}
  return working(file);
 };
 const receipt=store.save({...request,expectedVersion:saved.version,markdown:'New saved text'});
 assert.equal(reads,2);assert.equal(receipt.committed,true);assert.equal(receipt.workingCopyUpdated,false);
 assert.equal(store.head(request.context).version,receipt.version);
 assert.equal(store.head(request.context).saved.markdown,'New saved text');
 assert.equal(readFileSync(loc.file,'utf8'),'External edit during save');
});

test('restore keeps its committed pointer when the working-file write fails',t=>{
 const {store}=fixture(t),request=first(),saved=store.save(request);
 store.save({...request,expectedVersion:saved.version,markdown:'Current text'});
 const loc=store.location(request.context),inspection=store.inspect(request.context);
 failRename(t,loc.file);
 const working=store.working.bind(store);let reads=0;
 store.working=file=>{reads++;return working(file);};
 const receipt=store.restore(request.context,saved.version,inspection.headHash,inspection.workingCopyHash);
 assert.equal(reads,2);assert.equal(receipt.restored,true);assert.equal(receipt.workingCopyUpdated,false);
 assert.equal(store.head(request.context).version,saved.version);
 assert.equal(readFileSync(loc.file,'utf8'),'Current text');
});

test('damaged HEAD is not silently reset; explicit recovery preserves damaged bytes and manual text',t=>{
 const {workspace,store}=fixture(t),a=store.save(first()),loc=store.location('notes/handoff.md');
 writeFileSync(loc.head,'corrupt');writeFileSync(join(workspace,'notes/handoff.md'),'manual text');
 assert.throws(()=>store.resume({context:'notes/handoff.md'}));assert.throws(()=>store.save(first('reset attempt')));
 const inspection=store.inspect('notes/handoff.md');assert.equal(inspection.revisions.find(r=>r.version===a.version).valid,true);
 assert.throws(()=>store.restore('notes/handoff.md',a.version,null,inspection.workingCopyHash),/changed/);
 store.restore('notes/handoff.md',a.version,inspection.headHash,inspection.workingCopyHash);
 assert.equal(store.resume({context:'notes/handoff.md'}).version,a.version);
 const backup=readdirSync(loc.directory).find(n=>n.startsWith('recovery-'));const contents=JSON.parse(readFileSync(join(loc.directory,backup),'utf8'));
 assert.equal(Buffer.from(contents.head,'base64').toString(),'corrupt');assert.equal(contents.workingCopy,'manual text');
 unlinkSync(loc.head);assert.throws(()=>store.resume({context:'notes/handoff.md'}),/HEAD is missing/);
});
test('recovery preserves an edit made after validating the original working copy',t=>{
 const {store}=fixture(t),request=first(),a=store.save(request);
 store.save({...request,expectedVersion:a.version,markdown:'Current before recovery'});
 const loc=store.location(request.context),inspection=store.inspect(request.context),headBefore=readFileSync(loc.head);
 const verify=store.verifyEvidence.bind(store),working=store.working.bind(store);let workingReads=0;
 store.working=(file)=>{workingReads++;return working(file);};
 store.verifyEvidence=(...args)=>{verify(...args);writeFileSync(loc.file,'External edit during recovery');};
 const receipt=store.restore(request.context,a.version,inspection.headHash,inspection.workingCopyHash);
 assert.equal(receipt.restored,true);assert.equal(receipt.workingCopyUpdated,false);
 assert.equal(workingReads,2);assert.equal(store.head(request.context).version,a.version);
 assert.equal(readFileSync(loc.file,'utf8'),'External edit during recovery');
 const backup=readdirSync(loc.directory).find(name=>name.startsWith('recovery-'));
 const preserved=JSON.parse(readFileSync(join(loc.directory,backup),'utf8'));
 assert.equal(preserved.workingCopy,'Current before recovery');assert.deepEqual(Buffer.from(preserved.head,'base64'),headBefore);
});

test('inspection reads each shared snapshot once, checks every manifest and rechecks on later calls',t=>{
 const {workspace,store}=fixture(t),request=first();writeFileSync(join(workspace,'source.txt'),'shared evidence');
 let version=null;
 for(let i=0;i<20;i++)version=store.save({...request,expectedVersion:version,markdown:'Revision '+i,evidence:['source.txt']}).version;
 const snapshot=store.resume({context:request.context}).evidence[0].snapshot,loc=store.location(request.context);
 const manifest=store.revision(loc.directory,version).evidence[0];
 const read=fs.readFileSync;let reads=0;
 fs.readFileSync=function(file,...args){if(String(file)===snapshot)reads++;return read.call(this,file,...args);};syncBuiltinESMExports();
 try {
  const view=store.inspect(request.context);assert.ok(view.revisions.every(r=>r.valid));assert.equal(reads,1);
  const checked=new Map();store.verifyEvidence(loc.directory,[manifest],checked);
  assert.throws(()=>store.verifyEvidence(loc.directory,[{...manifest,bytes:manifest.bytes+1}],checked),/integrity/);
  assert.throws(()=>store.verifyEvidence(loc.directory,[{...manifest,hash:'0'.repeat(64)}],checked),/snapshot path|integrity/);
  assert.throws(()=>store.verifyEvidence(loc.directory,[{...manifest,path:'../outside.txt'}],checked));
  // Same byte length ensures the second inspection must check the content hash.
  writeFileSync(snapshot,'SHARED EVIDENCE');reads=0;
  assert.ok(store.inspect(request.context).revisions.every(r=>!r.valid));assert.equal(reads,1);
 } finally {fs.readFileSync=read;syncBuiltinESMExports();}
});

test('inspection reports ancestry and reachability without rereading revisions',t=>{
 const {store}=fixture(t),request=first();assert.equal(store.inspect(request.context).ancestry.status,'empty');
 const a=store.save(request),b=store.save({...request,expectedVersion:a.version,markdown:'Second'});
 let view=store.inspect(request.context);assert.equal(view.ancestry.status,'complete');assert.deepEqual(view.ancestry.missingParents,[]);
 assert.ok(view.revisions.every(r=>r.reachableFromHead===true));
 store.restore(request.context,a.version,view.headHash,view.workingCopyHash);
 const original=store.revision.bind(store),reads=[];store.revision=(directory,version)=>{reads.push(version);return original(directory,version);};
 view=store.inspect(request.context);
 assert.equal(view.ancestry.headVersion,a.version);assert.equal(view.ancestry.status,'complete');
 assert.equal(view.revisions.find(r=>r.version===a.version).reachableFromHead,true);
 assert.equal(view.revisions.find(r=>r.version===b.version).reachableFromHead,false);
 assert.equal(view.revisions.find(r=>r.version===b.version).valid,true);
 assert.deepEqual(reads.sort(),[a.version,b.version].sort());
});

test('inspection distinguishes missing ancestry, corrupt records and unreadable HEAD',t=>{
 const {store}=fixture(t),request=first(),a=store.save(request),b=store.save({...request,expectedVersion:a.version,markdown:'Second'});
 const loc=store.location(request.context),oldFile=join(loc.directory,'revisions',a.version+'.json'),oldBytes=readFileSync(oldFile),headBytes=readFileSync(loc.head);
 renameSync(oldFile,oldFile+'.held');let view=store.inspect(request.context);
 assert.equal(view.ancestry.status,'incomplete');assert.equal(view.ancestry.reason,'missing_revision');assert.equal(view.ancestry.blockedAt,a.version);
 assert.deepEqual(view.ancestry.missingParents,[{version:b.version,parent:a.version}]);assert.equal(view.revisions[0].valid,true);
 assert.equal(view.revisions[0].reachableFromHead,true);
 writeFileSync(oldFile,'corrupt');view=store.inspect(request.context);
 assert.equal(view.ancestry.reason,'invalid_revision');assert.equal(view.revisions.find(r=>r.version===a.version).valid,false);
 assert.equal(view.revisions.find(r=>r.version===a.version).reachableFromHead,true);
 writeFileSync(loc.head,'corrupt');view=store.inspect(request.context);
 assert.equal(view.ancestry.status,'unavailable');assert.equal(view.ancestry.reason,'invalid_head');assert.ok(view.revisions.every(r=>r.reachableFromHead===null));
 unlinkSync(loc.head);assert.equal(store.inspect(request.context).ancestry.reason,'missing_head');
 writeFileSync(oldFile,oldBytes);writeFileSync(loc.head,headBytes);assert.equal(store.inspect(request.context).ancestry.status,'complete');
});

test('snapshot corruption affects file integrity without falsely breaking parent relationships',t=>{
 const {workspace,store}=fixture(t);writeFileSync(join(workspace,'source.txt'),'evidence');
 const request={...first(),evidence:['source.txt']};store.save(request);
 writeFileSync(store.resume({context:request.context}).evidence[0].snapshot,'corrupt');
 const view=store.inspect(request.context);assert.equal(view.ancestry.status,'complete');
 assert.equal(view.revisions[0].valid,false);assert.equal(view.revisions[0].reachableFromHead,true);
});

test('interrupted initial commit leaves inspectable history and requires explicit recovery',t=>{
 const {store}=fixture(t),loc=store.location('notes/handoff.md');const restoreRename=failRename(t,loc.head);
 assert.throws(()=>store.save(first()));assert.throws(()=>store.resume({context:'notes/handoff.md'}),/HEAD is missing/);
 const inspection=store.inspect('notes/handoff.md');assert.equal(inspection.revisions.length,1);assert.equal(inspection.revisions[0].valid,true);
 restoreRename();const r=store.restore('notes/handoff.md',inspection.revisions[0].version,inspection.headHash,inspection.workingCopyHash);
 assert.equal(r.restored,true);assert.equal(store.resume({context:'notes/handoff.md'}).markdown,first().markdown);
});
test('tampered evidence and revisions are refused; restore does not change source files',t=>{
 const {store,workspace}=fixture(t);writeFileSync(join(workspace,'s.txt'),'one');const a=store.save({...first(),evidence:['s.txt']});
 writeFileSync(join(workspace,'s.txt'),'two');const inspection=store.inspect('notes/handoff.md');store.restore('notes/handoff.md',a.version,inspection.headHash,inspection.workingCopyHash);assert.equal(readFileSync(join(workspace,'s.txt'),'utf8'),'two');
 const view=store.resume({context:'notes/handoff.md'});writeFileSync(view.evidence[0].snapshot,'tampered');assert.throws(()=>store.resume({context:'notes/handoff.md'}),/integrity/);
 writeFileSync(join(store.location('notes/handoff.md').directory,'revisions',a.version+'.json'),'{}');assert.throws(()=>store.resume({context:'notes/handoff.md'}),/integrity/);
});
test('workspace and internal paths, ambiguous Windows names, oversized inputs and links are rejected',t=>{
 const {workspace,store}=fixture(t);
 for(const context of ['../outside.md','.git/config.md','.glue/other.md','notes/x.md:stream','CON.md','a./x.md'])assert.throws(()=>store.resume({context}));
 assert.throws(()=>store.save({...first(),markdown:'🙂'.repeat(17000)}));
 const target=join(workspace,'target');mkdirSync(target);symlinkSync(target,join(workspace,'linked'),'junction');assert.throws(()=>store.resume({context:'linked/handoff.md'}),/linked/);
});
test('rejected metadata evidence explains the boundary without echoing the path and leaves the checkpoint unchanged',t=>{
 const {workspace,store}=fixture(t),a=store.save(first());
 writeFileSync(join(workspace,'source.txt'),'ordinary evidence');
 for(const path of ['.git/config','.codex/config.toml','.agents/skills/glue/SKILL.md','.claude/settings.json','.glue/contexts/example']) {
  assert.throws(()=>store.save({context:'notes/handoff.md',expectedVersion:a.version,markdown:'Must not commit',evidence:['source.txt',path]}),error=>{
   assert.equal(error.message.includes(JSON.stringify(path)),false);assert.match(error.message,/ordinary workspace files/);return true;
  });
  assert.equal(store.resume({context:'notes/handoff.md'}).version,a.version);
 }
 const b=store.save({context:'notes/handoff.md',expectedVersion:a.version,markdown:'Corrected evidence selection',evidence:['source.txt']});
 assert.equal(b.committed,true);assert.equal(store.resume({context:'notes/handoff.md'}).evidence[0].path,'source.txt');
});

test('independent contexts do not share versions or content',t=>{
 const {store}=fixture(t),a=store.save(first('A'));store.save({...first('B'),context:'other.md'});
 assert.throws(()=>store.save({context:'other.md',expectedVersion:a.version,markdown:'wrong version'}),/conflict/);
 assert.equal(store.resume({context:'notes/handoff.md'}).markdown,'A');assert.equal(store.resume({context:'other.md'}).markdown,'B');
});
test('two independent processes cannot silently overwrite the same base version',async t=>{
 const {workspace,store}=fixture(t),a=store.save(first());
 const script=`import {Handoffs} from ${JSON.stringify(pathToFileURL(resolve('dist/handoff.js')).href)};try { console.log(JSON.stringify(new Handoffs(process.argv[1]).save(JSON.parse(process.argv[2])))); } catch(e) {console.error(e.message);process.exitCode=1}`;
 const execute=markdown=>new Promise(resolve=>{const p=spawn(process.execPath,['--input-type=module','-e',script,workspace,JSON.stringify({context:'notes/handoff.md',expectedVersion:a.version,markdown})],{windowsHide:true});let out='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>out+=b);p.on('close',code=>resolve({code,out}));});
 const results=await Promise.all([execute('Writer A'),execute('Writer B')]);assert.equal(results.filter(r=>r.code===0).length,1);assert.match(results.find(r=>r.code!==0).out,/busy|conflict/);assert.match(store.resume({context:'notes/handoff.md'}).markdown,/Writer [AB]/);
});
test('MCP exposes six tools, leaves unrelated files untouched and rejects unknown actions',t=>{
 const {workspace}=fixture(t);writeFileSync(join(workspace,'unrelated.txt'),'unrelated content');
 const requests=[{id:1,method:'tools/list'},{id:2,method:'tools/call',params:{name:'glue_resume',arguments:{context:'handoff.md'}}},{id:3,method:'tools/call',params:{name:'unknown_tool',arguments:{}}},{id:4,method:'tools/call',params:{name:'glue_checkpoint',arguments:{...first('MCP ✅')}}}];
 const p=mcpRun(workspace,{input:requests.map(r=>JSON.stringify({jsonrpc:'2.0',...r})).join('\n')+'\n',encoding:'utf8'});assert.equal(p.status,0,p.stderr);
 const rows=p.stdout.trim().split('\n').map(JSON.parse);assert.deepEqual(rows[0].result.tools.map(t=>t.name),['glue_resume','glue_checkpoint','glue_find','glue_read','glue_check_capture','glue_transfer']);assert.ok(rows[0].result.tools.every(tool=>tool.inputSchema.type==='object'));assert.equal(rows[0].result.tools.find(tool=>tool.name==='glue_transfer').annotations.readOnlyHint,false);
 assert.equal(JSON.parse(rows[1].result.content[0].text).version,null);assert.equal(rows[2].error.code,-32602);assert.equal(JSON.parse(rows[3].result.content[0].text).committed,true);
 assert.equal(readFileSync(join(workspace,'unrelated.txt'),'utf8'),'unrelated content');
});

test('MCP rejects invalid UTF-8 requests without writes and continues with valid requests',t=>{
 const {workspace,store}=fixture(t),request=first(),saved=store.save(request),before=collectFiles(workspace);
 const malformed=Buffer.concat([
  Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"glue_checkpoint","arguments":{"context":"unexpected.md","expectedVersion":null,"markdown":"'),
  Buffer.from([255]),Buffer.from('"}}}\n'),
 ]);
 const valid=[{jsonrpc:'2.0',id:'Unicode 🙂',method:'ping'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'glue_resume',arguments:{context:request.context}}}];
 const input=Buffer.concat([malformed,Buffer.from(valid.map(r=>JSON.stringify(r)).join('\n'))]);
 const p=mcpRun(workspace,{input,encoding:'utf8',windowsHide:true});
 assert.equal(p.status,0,p.stderr);assert.equal(p.stderr,'');const rows=p.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(rows.length,3);assert.equal(rows[0].id,null);assert.equal(rows[0].error.code,-32700);
 assert.equal(rows[1].id,'Unicode 🙂');assert.deepEqual(rows[1].result,{});
 const resumed=JSON.parse(rows[2].result.content[0].text);assert.equal(resumed.version,saved.version);assert.equal(resumed.markdown,request.markdown);
 assert.deepEqual(collectFiles(workspace),before);
});

test('MCP rejects an incomplete UTF-8 sequence at EOF without crashing or writing',t=>{
 const {workspace}=fixture(t);
 const p=mcpRun(workspace,{input:Buffer.from([0xe2,0x82]),encoding:'utf8',windowsHide:true});
 assert.equal(p.status,0,p.stderr);assert.equal(JSON.parse(p.stdout).error.code,-32700);assert.deepEqual(readdirSync(workspace),[]);
});

test('MCP refuses oversized requests before any write',t=>{
 const {workspace}=fixture(t);
 const p=mcpRun(workspace,{input:Buffer.alloc(2*1024*1024+1,32),encoding:'utf8',windowsHide:true});
 assert.equal(p.status,0,p.stderr);assert.equal(JSON.parse(p.stdout.trim()).error.code,-32600);assert.deepEqual(readdirSync(workspace),[]);
});

test('MCP delegates argument validation to core and rejects malformed calls without writes',t=>{
 const {workspace,store}=fixture(t),request=first(),saved=store.save(request),before=collectFiles(workspace);
 const cases=[['glue_resume',undefined],['glue_resume',null],['glue_resume',{context:42}],['glue_resume',{context:request.context,extra:true}],
  ['glue_checkpoint',{}],['glue_checkpoint',{...request,markdown:42}],['glue_checkpoint',{...request,expectedVersion:42}],['glue_checkpoint',{...request,extra:true}]];
 cases.push(['glue_find',null],['glue_find',{limit:0}],['glue_find',{extra:true}],['glue_read',{}],['glue_read',{context:request.context,offset:-1}],['glue_read',{context:request.context,extra:true}]);
 for(const [name,args] of cases) {
  if(name==='glue_resume')assert.throws(()=>store.resume(args));
  if(name==='glue_checkpoint')assert.throws(()=>store.save(args));
 }
 const requests=cases.map(([name,args],id)=>({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}}));
 requests.push({jsonrpc:'2.0',id:cases.length,method:'tools/call',params:{name:'glue_resume',arguments:{context:request.context}}});
 const p=mcpRun(workspace,{input:requests.map(r=>JSON.stringify(r)).join('\n')+'\n',encoding:'utf8',windowsHide:true});
 assert.equal(p.status,0,p.stderr);const rows=p.stdout.trim().split('\n').map(JSON.parse);assert.equal(rows.length,requests.length);
 for(let i=0;i<cases.length;i++){assert.equal(rows[i].id,i);assert.equal(rows[i].result.isError,true);}
 assert.equal(JSON.parse(rows.at(-1).result.content[0].text).version,saved.version);
 assert.deepEqual(collectFiles(workspace),before);
});

test('save and restore preserve unrelated sibling temporary files',t=>{
 const {workspace,store}=fixture(t),request=first(),loc=store.location(request.context);
 mkdirSync(join(workspace,'notes'));writeFileSync(loc.file+'.tmp','Editor recovery text');
 const firstSave=store.save(request);assert.equal(firstSave.workingCopyUpdated,true);
 store.save({...request,expectedVersion:firstSave.version,markdown:'Later text'});
 const inspection=store.inspect(request.context);
 assert.equal(store.restore(request.context,firstSave.version,inspection.headHash,inspection.workingCopyHash).workingCopyUpdated,true);
 assert.equal(readFileSync(loc.file+'.tmp','utf8'),'Editor recovery text');
 assert.equal(readFileSync(loc.file,'utf8'),request.markdown);
 assert.deepEqual(readdirSync(join(workspace,'notes')).sort(),['handoff.md','handoff.md.tmp']);
});

test('restoring a pre-marker first-save orphan establishes missing-HEAD protection',t=>{
 const {store}=fixture(t),request=first(),loc=store.location(request.context),marker=join(loc.directory,'.initialized');
 const original=fs.openSync;let version;
 try {
  fs.openSync=(file,...args)=>{if(file===marker)throw Error('Injected marker failure');return original(file,...args);};
  syncBuiltinESMExports();
  assert.throws(()=>store.save(request),/Injected marker failure/);
  const inspection=store.inspect(request.context);assert.equal(inspection.revisions.length,1);assert.equal(inspection.revisions[0].valid,true);
  version=inspection.revisions[0].version;
  // Restore must not commit a new HEAD if its marker cannot be created.
  assert.throws(()=>store.restore(request.context,version,inspection.headHash,inspection.workingCopyHash),/Injected marker failure/);
  assert.equal(existsSync(loc.head),false);assert.equal(existsSync(marker),false);
 } finally {fs.openSync=original;syncBuiltinESMExports();}
 const inspection=store.inspect(request.context);
 assert.equal(store.restore(request.context,version,inspection.headHash,inspection.workingCopyHash).restored,true);
 assert.equal(readFileSync(marker,'utf8'),'Glue handoff initialized\n');
 assert.equal(store.resume({context:request.context}).version,version);
 unlinkSync(loc.head);
 assert.throws(()=>store.resume({context:request.context}),/HEAD is missing/);
 assert.throws(()=>store.save({...request,workingCopyHash:store.working(loc.file).hash}),/HEAD is missing/);
 assert.deepEqual(readdirSync(join(loc.directory,'revisions')),[version+'.json']);
 assert.equal(store.inspect(request.context).revisions[0].valid,true);
});
test('nested metadata directories, filesystem aliases and host instruction files are refused',t=>{
 const {workspace,store}=fixture(t);
 mkdirSync(join(workspace,'sub','.git'),{recursive:true});writeFileSync(join(workspace,'sub','.git','config'),'nested');
 assert.throws(()=>store.save({...first(),evidence:['sub/.git/config']}),/outside \.git/);
 for(const context of ['AGENTS.md','CLAUDE.md','docs/claude.local.md','skills/x/SKILL.md','.github/workflows/note.md','.cursor/rules/note.md','notes/.hidden/x.md']){
  assert.throws(()=>store.save({...first(),context}),/host instruction file/);assert.throws(()=>store.resume({context}),/host instruction file/);
 }
 writeFileSync(join(workspace,'AGENTS.md'),'# Project instructions');
 assert.equal(store.save({...first(),evidence:['AGENTS.md']}).committed,true);assert.equal(readFileSync(join(workspace,'AGENTS.md'),'utf8'),'# Project instructions');
 mkdirSync(join(workspace,'longdirectoryname'));writeFileSync(join(workspace,'longdirectoryname','source.txt'),'source');
 // Short names exist only on some Windows volumes.
 if(existsSync(join(workspace,'LONGDI~1','source.txt'))){
  assert.throws(()=>store.save({context:'notes/alias.md',expectedVersion:null,markdown:'# Alias',evidence:['LONGDI~1/source.txt']}),/ambiguous/);
  assert.throws(()=>store.save({context:'LONGDI~1/alias.md',expectedVersion:null,markdown:'# Alias',evidence:[]}),/ambiguous/);
 }
});

test('readers retry an unfinished first save and read it normally after publication',t=>{
 const {workspace,store}=fixture(t),request=first(),loc=store.location(request.context),reader=new Handoffs(workspace),knowledge=new Knowledge(reader);
 const original=fs.renameSync;let observed=false;
 try {
  fs.renameSync=(from,to)=>{
   if(to===loc.head){
    observed=true;assert.equal(existsSync(join(loc.directory,'.initialized')),true);assert.equal(existsSync(loc.head),false);
    const before=collectFiles(workspace);
    assert.throws(()=>reader.resume({context:request.context}),error=>error.code==='EEXIST'&&error.retryable===true&&/busy/.test(error.message));
    const page=knowledge.find({});assert.equal(page.gaps[0].reason,'busy');assert.equal('context' in page.gaps[0],false);
    const child=mcpRun(workspace,{input:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'glue_resume',arguments:{context:request.context}}})+'\n',encoding:'utf8',timeout:10000});
    assert.equal(child.status,0,child.stderr);const response=JSON.parse(child.stdout);
    assert.equal(response.result.isError,true);assert.match(response.result.content[0].text,/Glue store is busy/);assert.doesNotMatch(response.result.content[0].text,/explicit recovery/);
    assert.equal(response.result.content[0].text.includes(workspace),false);assert.deepEqual(collectFiles(workspace),before);
   }
   return original(from,to);
  };syncBuiltinESMExports();
  assert.equal(store.save(request).committed,true);
 } finally {fs.renameSync=original;syncBuiltinESMExports();}
 assert.equal(observed,true);assert.equal(reader.resume({context:request.context}).markdown,request.markdown);
 assert.equal(knowledge.find({}).results.length,1);assert.deepEqual(knowledge.find({}).gaps,[]);
});

test('readers recheck a HEAD published during missing-pointer observations',t=>{
 const {workspace,store}=fixture(t),request=first(),saved=store.save(request),loc=store.location(request.context),knowledge=new Knowledge(store);
 mkdirSync(join(loc.directory,'.write-lock'));const before=collectFiles(workspace),original=fs.existsSync;
 for(const read of [()=>store.resume({context:request.context}).version,()=>knowledge.find({}).results[0].version]){
  let firstCheck=true;
  try {
   fs.existsSync=file=>{if(file===loc.head&&firstCheck){firstCheck=false;return false;}return original(file);};syncBuiltinESMExports();
   assert.equal(read(),saved.version);assert.equal(firstCheck,false);
  } finally {fs.existsSync=original;syncBuiltinESMExports();}
 }
 assert.equal(store.resume({context:request.context}).version,saved.version);assert.deepEqual(collectFiles(workspace),before);
});

test('an interrupted first save keeps its lock and history until explicit recovery',t=>{
 const {workspace,store}=fixture(t),request=first(),loc=store.location(request.context);
 const harness=`
  import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
  const {Handoffs}=await import(${JSON.stringify(new URL('../dist/handoff.js',import.meta.url).href)});
  const store=new Handoffs(process.argv[1]),request=${JSON.stringify(request)},loc=store.location(request.context),original=fs.renameSync;
  fs.renameSync=(from,to)=>{if(to===loc.head)process.exit(0);return original(from,to);};syncBuiltinESMExports();
  store.save(request);process.exit(9);
 `;
 const child=spawnSync(process.execPath,['--input-type=module','-e',harness,workspace],{encoding:'utf8',windowsHide:true,timeout:10000});
 assert.equal(child.status,0,child.stderr);const lock=join(loc.directory,'.write-lock');
 assert.equal(existsSync(lock),true);assert.equal(existsSync(join(loc.directory,'.initialized')),true);assert.equal(existsSync(loc.head),false);
 const before=collectFiles(workspace),knowledge=new Knowledge(store);
 assert.throws(()=>store.resume({context:request.context}),error=>error.code==='EEXIST'&&error.retryable===true);
 assert.equal(knowledge.find({}).gaps[0].reason,'busy');assert.throws(()=>store.save(request),error=>error.code==='EEXIST');assert.deepEqual(collectFiles(workspace),before);
 // The child has exited; validate the exact fixture lock before operator removal.
 assert.equal(fs.realpathSync(lock),join(fs.realpathSync(workspace),'.glue','contexts',hash(request.context),'.write-lock'));
 rmSync(lock,{recursive:true});const preserved=collectFiles(workspace);
 assert.throws(()=>store.resume({context:request.context}),/HEAD is missing/);assert.equal(knowledge.find({}).gaps[0].reason,'missing_head');
 assert.throws(()=>store.save(request),/HEAD is missing/);assert.deepEqual(collectFiles(workspace),preserved);
 const inspection=store.inspect(request.context);assert.equal(inspection.revisions.length,1);assert.equal(inspection.revisions[0].valid,true);
 assert.equal(store.restore(request.context,inspection.revisions[0].version,inspection.headHash,inspection.workingCopyHash).restored,true);
 assert.equal(store.resume({context:request.context}).markdown,request.markdown);
});
