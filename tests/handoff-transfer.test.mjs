import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync,rmSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Handoffs,hash} from '../dist/handoff.js';
import {Transfers} from '../dist/transfer.js';

function fixture(t){const workspace=mkdtempSync(join(realpathSync(tmpdir()),'glue-transfer-'));t.after(()=>rmSync(workspace,{recursive:true,force:true}));const store=new Handoffs(workspace);return {workspace,store,transfers:new Transfers(store)};}
const capture=(id,text,extra={})=>({id,label:'Selected source',representation:'excerpt',basis:'Selected paragraph',scope:'Applies to the named experiment only.',transfer:'allowed',base64:Buffer.from(text).toString('base64'),...extra});
const save=(store,markdown,extra={})=>store.save({context:'note.md',expectedVersion:null,markdown,...extra});
function exported(transfers,selection){const preview=transfers.run({action:'preview',...selection});return transfers.run({action:'export',...selection,reviewedHash:preview.payloadHash});}

test('preview returns hashes and scope without payload bytes; exact review gates export',t=>{
 const {store,transfers}=fixture(t),receipt=save(store,'SELECTED_MARKDOWN_CONTENT',{captures:[capture('a','SELECTED_CAPTURE_CONTENT')]});
 const selection={context:'note.md',version:receipt.version,captures:['a']};
 const preview=transfers.run({action:'preview',...selection});
 assert.doesNotMatch(JSON.stringify(preview),/SELECTED_MARKDOWN_CONTENT|SELECTED_CAPTURE_CONTENT/);
 assert.equal(Object.hasOwn(preview,'bundle'),false);assert.equal(preview.manifest.captures.length,1);
 assert.throws(()=>transfers.run({action:'export',...selection,reviewedHash:hash('wrong')}),/not reviewed/);
 const result=transfers.run({action:'export',...selection,reviewedHash:preview.payloadHash});
 assert.equal(result.bundle.markdown,'SELECTED_MARKDOWN_CONTENT');assert.equal(result.independentCopy,true);
 assert.equal(transfers.run({action:'preview',...selection}).payloadHash,preview.payloadHash);
});

test('selected transfer excludes support identities/history and imports a proposed independent copy',t=>{
 const source=fixture(t),target=fixture(t);
 writeFileSync(join(source.workspace,'excluded-private-name.txt'),'EXCLUDED_PRIVATE_PAYLOAD');
 const dependency=source.store.save({context:'private-dependency.md',expectedVersion:null,markdown:'PRIVATE_DEPENDENCY_PAYLOAD'});
 const first=save(source.store,'OLD_PRIVATE_HISTORY');
 const current=source.store.save({context:'note.md',expectedVersion:first.version,markdown:'Reviewed current summary',evidence:['excluded-private-name.txt'],
  captures:[capture('a','Selected support'),capture('b','UNSELECTED_CAPTURE_PAYLOAD',{transfer:'project-only'})],
  dependsOn:[{context:'private-dependency.md',version:dependency.version}],
  record:{title:'Bounded finding',scope:'Only the named experiment.',kind:'finding',provenance:'user',status:'active'}});
 const {bundle,payloadHash}=exported(source.transfers,{context:'note.md',version:current.version,captures:['a']});
 assert.equal(bundle.omittedSupport,3);
 assert.doesNotMatch(JSON.stringify(bundle),/OLD_PRIVATE_HISTORY|PRIVATE_DEPENDENCY|private-dependency|excluded-private-name|EXCLUDED_PRIVATE|UNSELECTED_CAPTURE/);
 const reviewed=target.transfers.run({action:'preview-import',bundle});assert.equal(reviewed.payloadHash,payloadHash);
 const input={action:'import',bundle,reviewedHash:payloadHash,context:'reused.md',expectedVersion:null};
 const imported=target.transfers.run(input);assert.equal(imported.committed,true);assert.equal(imported.upstreamStatus,'not-checked');
 const saved=target.store.head('reused.md').saved;
 assert.equal(saved.record.status,'proposed');assert.equal(saved.record.provenance,'source');assert.equal(saved.imported.sourceStatus,'active');assert.equal(saved.imported.sourceProvenance,'user');assert.equal(saved.imported.localModified,false);assert.equal(saved.imported.payloadHash,payloadHash);
 assert.deepEqual(saved.dependsOn,[]);assert.deepEqual(saved.evidence,[]);assert.equal(saved.captures.length,1);
 assert.equal(target.transfers.run(input).replayed,true);
 assert.equal(saved.captures[0].originReceivedAt,source.store.head('note.md').saved.captures[0].receivedAt);
 assert.ok(saved.captures[0].receivedAt);
 const secondExport=exported(target.transfers,{context:'reused.md',version:imported.version,captures:['a']});
 assert.equal(secondExport.bundle.omittedSupport,3);
 assert.equal(secondExport.bundle.captures[0].originReceivedAt,saved.captures[0].originReceivedAt);
 source.store.save({context:'note.md',expectedVersion:current.version,markdown:'Changed upstream'});
 assert.equal(target.store.resume({context:'reused.md'}).markdown,'Reviewed current summary');
});

test('project-only and sensitive selected captures refuse export and scoped records remain restricted',t=>{
 for(const item of [capture('a','Ordinary private capture',{transfer:'project-only'}),capture('a','Restricted',{scope:'Do not share this capture'}),capture('a','password=FAKE_SYNTHETIC_SECRET',{sensitiveAcknowledgement:hash('password=FAKE_SYNTHETIC_SECRET')})]){
  const {store,transfers}=fixture(t),receipt=save(store,'A safe summary',{captures:[item]});
  assert.throws(()=>transfers.run({action:'preview',context:'note.md',version:receipt.version,captures:['a']}),/private or sensitive/);
 }
 const {store,transfers}=fixture(t),receipt=save(store,'Restricted finding',{record:{title:'Finding',scope:'Project-only exception',kind:'finding',provenance:'user',status:'active'}});
 assert.throws(()=>transfers.run({action:'preview',context:'note.md',version:receipt.version}),/restricts transfer/);
});

test('payload privacy checks include text and explicit derivatives carry a new identity',t=>{
 const {store,transfers}=fixture(t),receipt=save(store,'Contact private.person@example.invalid for this work.');
 const selection={context:'note.md',version:receipt.version};
 assert.throws(()=>transfers.run({action:'preview',...selection}),/private locator/);
 const {bundle}=exported(transfers,{...selection,derivativeMarkdown:'A reviewed anonymous summary.'});
 assert.equal(bundle.derived,true);assert.equal(bundle.markdownHash,hash('A reviewed anonymous summary.'));
 assert.notEqual(bundle.markdownHash,hash(store.head('note.md').saved.markdown));
 assert.equal(bundle.origin.version,receipt.version);
});

test('evidence selection uses reviewed portable labels rather than private source paths',t=>{
 const {workspace,store,transfers}=fixture(t);writeFileSync(join(workspace,'internal-source-name.txt'),'Reviewed evidence');
 const receipt=save(store,'A selected finding',{evidence:['internal-source-name.txt']});
 const {bundle}=exported(transfers,{context:'note.md',version:receipt.version,evidence:[{path:'internal-source-name.txt',id:'source',label:'Experiment extract',scope:'This experiment only'}]});
 assert.doesNotMatch(JSON.stringify(bundle),/internal-source-name/);assert.equal(bundle.captures[0].representation,'original-bytes');
 assert.equal(Buffer.from(bundle.captures[0].base64,'base64').toString(),'Reviewed evidence');
 assert.throws(()=>transfers.run({action:'preview',context:'note.md',version:receipt.version,evidence:[{path:'internal-source-name.txt',id:'a',label:'A',scope:'This experiment'},{path:'INTERNAL-SOURCE-NAME.TXT',id:'b',label:'B',scope:'This experiment'}]}),/only once/);
});

test('bundle tampering, stale review and size rejection leave destination uncommitted',t=>{
 const source=fixture(t),target=fixture(t),receipt=save(source.store,'Safe content');
 const {bundle,payloadHash}=exported(source.transfers,{context:'note.md',version:receipt.version});
 assert.throws(()=>target.transfers.run({action:'import',bundle,reviewedHash:hash('wrong'),context:'target.md',expectedVersion:null}),/not reviewed/);
 assert.throws(()=>target.transfers.run({action:'preview-import',bundle:{...bundle,markdown:'Altered'}}),/integrity/);
 assert.equal(existsSync(join(target.workspace,'.glue')),false);
 const big=source.store.save({context:'big.md',expectedVersion:null,markdown:'Big selection',captures:[capture('large','x'.repeat(800000))]});
 assert.throws(()=>source.transfers.run({action:'preview',context:'big.md',version:big.version,captures:['large']}),/1 MiB/);
 const changed=source.store.save({context:'note.md',expectedVersion:receipt.version,markdown:'New content'});
 assert.throws(()=>source.transfers.run({action:'export',context:'note.md',version:receipt.version,reviewedHash:payloadHash}),/current saved/);
 assert.notEqual(changed.version,receipt.version);
});

test('opaque project namespace is stable and independent from paths',t=>{
 const a=fixture(t),b=fixture(t),one=save(a.store,'One'),two=save(b.store,'One');
 const first=exported(a.transfers,{context:'note.md',version:one.version}).bundle.origin;
 const next=exported(a.transfers,{context:'note.md',version:one.version}).bundle.origin;
 const other=exported(b.transfers,{context:'note.md',version:two.version}).bundle.origin;
 assert.equal(first.namespace,next.namespace);assert.notEqual(first.namespace,other.namespace);
 assert.match(first.namespace,/^[a-f0-9-]{36}$/);assert.equal(first.id,other.id);
 const stored=JSON.parse(readFileSync(join(a.workspace,'.glue/PROJECT.json'),'utf8'));assert.equal(stored.namespace,first.namespace);
});


test('deliberate upstream comparison is host-asserted, does not fetch or adopt, and preserves saved bytes',t=>{
 const source=fixture(t),target=fixture(t),saved=save(source.store,'Safe imported claim');
 const {bundle,payloadHash}=exported(source.transfers,{context:'note.md',version:saved.version});
 const imported=target.transfers.run({action:'import',bundle,reviewedHash:payloadHash,context:'reused.md',expectedVersion:null});
 const before=JSON.stringify(target.store.head('reused.md').saved);
 for(const [upstream,status] of [[bundle.origin,'unchanged'],[{...bundle.origin,version:hash('updated')},'changed'],[{...bundle.origin,id:'different'},'different_source'],[null,'unavailable']]){
  const checked=target.transfers.run({action:'check',context:'reused.md',version:imported.version,upstream});
  assert.equal(checked.status,status);assert.equal(checked.evidence,'host_asserted_only');assert.equal(checked.changedStoredContent,false);
 }
 assert.equal(JSON.stringify(target.store.head('reused.md').saved),before);
 assert.equal(target.store.head('reused.md').version,imported.version);
});


test('local edits retain the original import receipt and mark modified content',t=>{
 const source=fixture(t),target=fixture(t),saved=save(source.store,'Original imported text');
 const {bundle,payloadHash}=exported(source.transfers,{context:'note.md',version:saved.version});
 const imported=target.transfers.run({action:'import',bundle,reviewedHash:payloadHash,context:'reused.md',expectedVersion:null});
 assert.equal(target.store.head('reused.md').saved.imported.localModified,false);
 target.store.save({context:'reused.md',expectedVersion:imported.version,markdown:'Local interpretation with edits'});
 const metadata=target.store.head('reused.md').saved.imported;
 assert.equal(metadata.localModified,true);assert.equal(metadata.payloadHash,payloadHash);
 assert.equal(metadata.origin.version,saved.version);
});
