import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync,writeFileSync,readFileSync,rmSync,unlinkSync,mkdirSync,renameSync,symlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,join} from 'node:path';
import {Handoffs,hash} from '../dist/handoff.js';
import {Knowledge} from '../dist/knowledge.js';

function fixture(t){const workspace=mkdtempSync(join(realpathSync(tmpdir()),'glue-knowledge-'));t.after(()=>rmSync(workspace,{recursive:true,force:true}));const store=new Handoffs(workspace);return {workspace,store,knowledge:new Knowledge(store)};}
const unavailableContext=(workspace,context)=>{const dir=join(workspace,'.glue/contexts',hash(context));mkdirSync(join(dir,'revisions'),{recursive:true});writeFileSync(join(dir,'.initialized'),'Glue handoff initialized\n');};
const record=(title)=>({title,kind:'finding',scope:'This project; one historical experiment, not a general product claim.',provenance:'source',status:'active'});
const save=(store,context,markdown,extra={})=>store.save({context,markdown,expectedVersion:null,...extra});

test('fresh discovery finds saved evidence and exact historical bytes survive correction and source deletion',t=>{
 const {workspace,store,knowledge}=fixture(t);const body=Buffer.from('Research: orchid quality tied.\r\n原始🙂 evidence.');writeFileSync(join(workspace,'trial.txt'),body);
 const a=save(store,'findings/quality.md','A bounded experiment; see original.',{record:record('Quality result'),evidence:['trial.txt']});
 const found=knowledge.find({query:'orchid',detail:'full'});assert.equal(found.results.length,1);assert.equal(found.results[0].context,'findings/quality.md');assert.equal(found.results[0].sources[0].hash,hash(body));
 assert.equal(found.results[0].freshness,'not_checked');assert.equal(found.results[0].record.scope,record('').scope);
 const b=store.save({context:'findings/quality.md',expectedVersion:a.version,markdown:'Corrected interpretation.',record:{...record('Quality result'),status:'proposed'}});
 assert.equal(knowledge.find({query:'bounded'}).results.length,0);
 const history=knowledge.find({query:'bounded',includeHistory:true});assert.equal(history.results[0].version,a.version);assert.equal(history.results[0].isHead,false);
 unlinkSync(join(workspace,'trial.txt'));
 const chunks=[];let offset=0;
 do{const page=knowledge.read({context:'findings/quality.md',version:a.version,source:'trial.txt',offset,limit:7,representation:'base64'});assert.equal(page.hash,hash(body));chunks.push(Buffer.from(page.base64,'base64'));offset=page.nextOffset;}while(offset!==null);
 assert.deepEqual(Buffer.concat(chunks),body);assert.equal(knowledge.read({context:'findings/quality.md',version:a.version}).currentVersion,b.version);
 assert.equal(knowledge.resume({context:'findings/quality.md'}).basis.status,'incomplete');
 assert.throws(()=>knowledge.read({context:'findings/quality.md',source:'unselected.txt'}),/not selected/);
});

test('declared dependency closure flags affected work, preserves old basis and ignores unrelated changes',t=>{
 const {workspace,store,knowledge}=fixture(t);writeFileSync(join(workspace,'owner.txt'),'Approved price 89; no publication permission.');
 const decision=save(store,'decisions/price.md','Use 89.',{record:{...record('Price'),kind:'decision',provenance:'user'},evidence:['owner.txt']});
 const finding=save(store,'findings/position.md','Positioning uses the price.',{record:record('Position'),dependsOn:[{context:'decisions/price.md',version:decision.version}]});
 const plan=save(store,'plan.md','Prepare draft.',{dependsOn:[{context:'findings/position.md',version:finding.version}]});
 save(store,'unrelated.md','Another exploration');assert.equal(knowledge.resume({context:'plan.md'}).basis.status,'unchanged');
 writeFileSync(join(workspace,'owner.txt'),'Approved price 95; still no publication permission.');
 const issue=knowledge.resume({context:'plan.md'}).basis.issues.find(i=>i.reason==='source_changed');
 assert.equal(issue.context,'decisions/price.md');assert.deepEqual(issue.via,['plan.md','findings/position.md']);
 assert.throws(()=>store.save({context:'plan.md',expectedVersion:plan.version,markdown:'Bad pin',dependsOn:[{context:'decisions/price.md',version:hash('wrong')}]}),/Dependency changed/);
 assert.equal(store.head('plan.md').version,plan.version);
 const revised=store.save({context:'decisions/price.md',expectedVersion:decision.version,markdown:'Use 95.',reviewedEvidence:[{path:'owner.txt',hash:hash(readFileSync(join(workspace,'owner.txt')))}]});
 assert.ok(knowledge.resume({context:'plan.md'}).basis.issues.some(i=>i.reason==='saved_revision_changed'));
 assert.equal(knowledge.read({context:'findings/position.md'}).dependsOn[0].version,decision.version);
 assert.notEqual(revised.version,decision.version);
 assert.throws(()=>store.save({context:'plan.md',expectedVersion:plan.version,markdown:'Self loop',dependsOn:[{context:'plan.md',version:plan.version}]}),/distinct other/);
});

test('search continuation covers revisions without duplicates, rejects stale cursors and discloses bounded evidence',t=>{
 const {workspace,store,knowledge}=fixture(t);writeFileSync(join(workspace,'large.txt'),'x'.repeat(300000)+' secretneedle');
 let receipt=save(store,'a.md','needle 1',{evidence:['large.txt']});
 for(let i=2;i<=3;i++)receipt=store.save({context:'a.md',expectedVersion:receipt.version,markdown:'needle '+i});
 const versions=[];let cursor;
 do{const page=knowledge.find({query:'needle',includeHistory:true,limit:1,...(cursor?{cursor}:{})});versions.push(...page.results.map(r=>r.version));assert.ok(page.skippedEvidenceBodies>0);cursor=page.next;}while(cursor);
 assert.equal(versions.length,3);assert.equal(new Set(versions).size,3);
 const page=knowledge.find({query:'needle',includeHistory:true,limit:1});
 store.save({context:'a.md',expectedVersion:receipt.version,markdown:'needle 4'});
 assert.throws(()=>knowledge.find({query:'needle',includeHistory:true,cursor:page.next}),/head changed/);
 assert.ok(knowledge.read({context:'a.md',source:'large.txt',offset:299990,limit:100}).text.includes('secretneedle'));
});

test('status-filtered records do not exhaust the evidence budget before an eligible match',t=>{
 const {workspace,store,knowledge}=fixture(t);
 const target='included-target.md',targetId=basename(store.location(target).directory);
 let excluded;
 for(let i=0;i<1000;i++){
  const candidate=`excluded-${String(i).padStart(3,'0')}.md`;
  if(basename(store.location(candidate).directory)<targetId){excluded=candidate;break;}
 }
 assert.ok(excluded);
 const ballast='b'.repeat(230*1024),term='filteredbudgetnarwhal';
 for(let i=0;i<4;i++)writeFileSync(join(workspace,`ballast-${i}.txt`),ballast);
 writeFileSync(join(workspace,'target.txt'),'t'.repeat(230*1024-term.length)+term);
 save(store,excluded,'Withdrawn',{record:{...record('Excluded'),status:'withdrawn'},evidence:[0,1,2,3].map(i=>`ballast-${i}.txt`)});
 save(store,target,'Active',{record:record('Included'),evidence:['target.txt']});
 const result=knowledge.find({query:term,status:['active'],detail:'full'});
 assert.equal(result.scannedRevisions,2);
 assert.deepEqual(result.results.map(item=>item.context),[target]);
 assert.equal(result.skippedEvidenceBodies,0);
 assert.equal(result.next,null);
});

test('knowledge reads reject orphan versions and corrupt snapshots; supersession remains explicit',t=>{
 const {workspace,store,knowledge}=fixture(t);writeFileSync(join(workspace,'source.txt'),'original');
 const replacement=save(store,'replacement.md','Current decision',{record:record('Current')});
 const old=save(store,'old.md','Old scope',{record:{...record('Old'),status:'superseded',supersededBy:{context:'replacement.md',version:replacement.version}},evidence:['source.txt']});
 assert.equal(knowledge.find({query:'Old'}).results[0].record.status,'superseded');
 assert.ok(knowledge.resume({context:'old.md'}).basis.issues.some(i=>i.reason==='record_superseded'));
 const loc=store.location('old.md'),fake=JSON.stringify({...store.revision(loc.directory,old.version),request:hash('uncommitted'),markdown:'orphan'}),orphan=hash(fake);
 writeFileSync(join(loc.directory,'revisions',orphan+'.json'),fake);
 assert.throws(()=>knowledge.read({context:'old.md',version:orphan}),/committed history/);
 const snapshot=store.resume({context:'old.md'}).evidence[0].snapshot;writeFileSync(snapshot,'tampered');
 assert.throws(()=>knowledge.read({context:'old.md',source:'source.txt'}),/integrity/);
 assert.ok(knowledge.find({query:'original'}).skippedEvidenceBodies>0);
 assert.throws(()=>save(store,'bad.md','Bad',{record:{...record('Bad'),status:'superseded'}}),/supersededBy/);
});

test('exact saved evidence survives a linked live source while snapshot checks remain enforced',t=>{
 const {workspace,store,knowledge}=fixture(t),context='handoff.md',source='sources/a.txt';
 mkdirSync(join(workspace,'sources'));writeFileSync(join(workspace,source),'saved original');
 const saved=save(store,context,'Original interpretation',{evidence:[source]});
 store.save({context,expectedVersion:saved.version,markdown:'Later interpretation'});
 const snapshot=store.resume({context}).evidence[0].snapshot;
 renameSync(join(workspace,'sources'),join(workspace,'moved-sources'));
 symlinkSync(join(workspace,'moved-sources'),join(workspace,'sources'),'junction');
 writeFileSync(join(workspace,'moved-sources/a.txt'),'changed live bytes');
 for(const version of [undefined,saved.version]){
  const read=knowledge.read({context,source,version});
  assert.equal(read.text,'saved original');assert.equal(read.hash,hash('saved original'));
 }
 assert.equal(knowledge.resume({context}).evidence[0].status,'unavailable');
 assert.throws(()=>store.save({context,expectedVersion:store.head(context).version,markdown:'Blocked capture'}),/linked/);
 assert.throws(()=>knowledge.read({context,source:'sources/unselected.txt'}),/not selected/);
 for(const path of ['../outside.txt','.agents/secret.txt','a.txt:stream'])assert.throws(()=>knowledge.read({context,source:path}));
 writeFileSync(snapshot,'corrupt');assert.throws(()=>knowledge.read({context,source}),/integrity/);
 writeFileSync(snapshot,'saved original');
 const evidence=join(store.location(context).directory,'evidence'),moved=join(workspace,'moved-snapshots');
 renameSync(evidence,moved);symlinkSync(moved,evidence,'junction');
 assert.throws(()=>knowledge.read({context,source}),/linked/);
});

test('search pages past unavailable contexts and continues healthy history without duplicates',t=>{
 const {workspace,store,knowledge}=fixture(t),context='healthy.md';
 const first=save(store,context,'needle original');
 const latest=store.save({context,expectedVersion:first.version,markdown:'needle latest'});
 // Failed first saves leave no directories; fabricate unavailable identities directly.
 for(let i=0,count=0;count<130;i++){
  const failed='failed-'+i+'.md';if(hash(failed)>=hash(context))continue;
  unavailableContext(workspace,failed);count++;
 }
 const options={query:'needle',includeHistory:true,limit:1};
 const page1=knowledge.find(options);assert.equal(page1.gaps.length,64);assert.deepEqual(page1.results,[]);
 assert.ok(page1.next.afterContextId);
 // Directory continuation must not require the unavailable anchor to survive.
 rmSync(join(workspace,'.glue/contexts',page1.next.afterContextId),{recursive:true});
 const page2=knowledge.find({...options,cursor:page1.next});assert.equal(page2.gaps.length,64);assert.deepEqual(page2.results,[]);
 assert.ok(page2.next.afterContextId>page1.next.afterContextId);
 const page3=knowledge.find({...options,cursor:page2.next});assert.equal(page3.gaps.length,2);
 assert.deepEqual(page3.results.map(r=>r.version),[latest.version]);assert.equal(page3.next.contextId,hash(context));
 const page4=knowledge.find({...options,cursor:page3.next});assert.deepEqual(page4.results.map(r=>r.version),[first.version]);assert.equal(page4.next,null);
 const gaps=[...page1.gaps,...page2.gaps,...page3.gaps];assert.equal(new Set(gaps.map(g=>g.contextId)).size,130);
 assert.throws(()=>knowledge.find({cursor:{...page1.next,...page3.next}}));
 store.save({context,expectedVersion:latest.version,markdown:'changed head'});
 assert.throws(()=>knowledge.find({...options,cursor:page3.next}),/head changed/);
});
test('unavailable-only search ends at its last directory without a spurious continuation',t=>{
 const {workspace,knowledge}=fixture(t);
 for(let i=0;i<64;i++)unavailableContext(workspace,'failed-'+i+'.md');
 const page=knowledge.find({});assert.equal(page.gaps.length,64);assert.equal(page.next,null);assert.deepEqual(page.results,[]);
 assert.equal(knowledge.find({cursor:{afterContextId:'f'.repeat(64)}}).next,null);
});


test('capture checking separates upstream version changes from representation and source identity',t=>{
 const {store,knowledge}=fixture(t), body=Buffer.from('Retained original text');
 const capture={id:'source',label:'Selected report',representation:'extracted-text',basis:'Pages 1-3, extractor v1',origin:{namespace:'example',id:'report',version:'v1'},scope:'This finding',base64:body.toString('base64')};
 const saved=save(store,'finding.md','Read selected report',{captures:[capture]});
 const check={context:'finding.md',capture:'source',hash:hash(body),representation:capture.representation,basis:capture.basis,origin:capture.origin,retrievedAt:'2026-09-18T00:00:00.000Z'};
 const unchanged=knowledge.checkCapture(check);
 assert.equal(unchanged.comparison,'same_supplied_bytes');assert.equal(unchanged.originVersionChanged,false);
 const revisedOrigin={...capture.origin,version:'v2'};
 const versionOnly=knowledge.checkCapture({...check,origin:revisedOrigin});
 assert.equal(versionOnly.comparison,'same_supplied_bytes');assert.equal(versionOnly.originVersionChanged,true);
 const changed=knowledge.checkCapture({...check,origin:revisedOrigin,hash:hash('Revised text')});
 assert.equal(changed.comparison,'supplied_bytes_changed');assert.equal(changed.originVersionChanged,true);
 assert.equal(knowledge.checkCapture({...check,basis:'Pages 1-4, extractor v1'}).comparison,'basis_changed');
 assert.equal(knowledge.checkCapture({...check,representation:'original-bytes'}).comparison,'basis_changed');
 const different=knowledge.checkCapture({...check,origin:{...capture.origin,id:'other-report'}});
 assert.equal(different.comparison,'basis_changed');assert.equal(different.declaredSourceIdentity,'different');
 assert.equal(knowledge.checkCapture({...check,origin:undefined}).declaredSourceIdentity,'not_established');
 assert.equal(store.head('finding.md').version,saved.version);
 assert.equal(knowledge.read({context:'finding.md',capture:'source'}).text,body.toString());
});

test('known omitted imported support makes local and downstream assessment incomplete',t=>{
 const {store,knowledge}=fixture(t);
 const imported={origin:{namespace:'example',id:'finding',version:'v1'},payloadHash:hash('selected payload'),omittedSupport:1,sourceStatus:'active',derived:false};
 const finding=store.save({context:'finding.md',markdown:'Selected independent copy',expectedVersion:null},imported);
 save(store,'plan.md','Uses selected finding',{dependsOn:[{context:'finding.md',version:finding.version}]});
 const local=knowledge.resume({context:'finding.md'}).basis;
 assert.equal(local.complete,false);assert.equal(local.status,'incomplete');
 assert.ok(local.issues.some(issue=>issue.reason==='imported_support_omitted'));
 const downstream=knowledge.resume({context:'plan.md'}).basis;
 assert.equal(downstream.complete,false);
 const issue=downstream.issues.find(issue=>issue.reason==='imported_support_omitted');
 assert.equal(issue.context,'finding.md');assert.deepEqual(issue.via,['plan.md']);
 assert.equal(issue.source,undefined);
 store.save({context:'complete-copy.md',markdown:'All deliberately selected support included',expectedVersion:null},{...imported,omittedSupport:0});
 assert.equal(knowledge.resume({context:'complete-copy.md'}).basis.status,'unchanged');
});


test('conditional resume omits only held Markdown and still observes live changes',t=>{
 const {workspace,store,knowledge}=fixture(t);
 writeFileSync(join(workspace,'source.txt'),'original');
 const dep=save(store,'dependency.md','Dependency',{evidence:['source.txt']});
 const saved=save(store,'plan.md','Keep decisions and open questions.',{dependsOn:[{context:'dependency.md',version:dep.version}]});
 const args={context:'plan.md',knownVersion:saved.version};
 const full=knowledge.resume({context:'plan.md'}),lean=knowledge.resume(args);
 assert.equal(lean.markdown,undefined);assert.equal(lean.markdownOmitted,'known_version');
 const {markdown,...rest}=full;assert.deepEqual(lean,{...rest,markdownOmitted:'known_version'});
 writeFileSync(join(workspace,'source.txt'),'changed');
 assert.ok(knowledge.resume(args).basis.issues.some(x=>x.reason==='source_changed'));
 unlinkSync(join(workspace,'source.txt'));
 assert.equal(knowledge.resume(args).basis.complete,false);
 writeFileSync(join(workspace,'source.txt'),'original');
 store.save({context:'dependency.md',expectedVersion:dep.version,markdown:'Updated dependency'});
 assert.ok(knowledge.resume(args).basis.issues.some(x=>x.reason==='saved_revision_changed'));
 writeFileSync(join(workspace,'plan.md'),'Manual edit');
 assert.equal(knowledge.resume(args).workingCopy.status,'edited');
 assert.equal(knowledge.resume({context:'plan.md',knownVersion:hash('other')}).markdown,full.markdown);
 assert.equal(knowledge.resume({context:'plan.md'}).markdown,full.markdown);
});

test('lean reads retain exact bytes for Unicode boundaries and binary evidence',t=>{
 const {workspace,store,knowledge}=fixture(t);
 writeFileSync(join(workspace,'binary.dat'),Buffer.from([255,0,254]));
 const saved=save(store,'unicode.md','🙂 café',{evidence:['binary.dat']});
 const args={context:'unicode.md',version:saved.version};
 const full=knowledge.read({...args,representation:'both'}),lean=knowledge.read(args);
 assert.deepEqual(lean,knowledge.read({...args,representation:'text'}));
 assert.equal(lean.text,full.text);assert.equal(lean.hash,full.hash);assert.equal(lean.base64,undefined);
 const binary=knowledge.read({...args,source:'binary.dat'});
 assert.deepEqual(Buffer.from(binary.base64,'base64'),Buffer.from([255,0,254]));
 const split=knowledge.read({...args,offset:1,limit:2});
 assert.equal(split.text,undefined);assert.equal(Buffer.from(split.base64,'base64').length,2);
 const encoded=knowledge.read({...args,representation:'base64'});
 assert.equal(encoded.text,undefined);assert.equal(encoded.base64,full.base64);
 assert.throws(()=>knowledge.read({...args,representation:'unknown'}));
});


test('find defaults compact listings and concise actual matches while full remains explicit',t=>{
 const {workspace,store,knowledge}=fixture(t);
 const body='Orchid migration '+ 'background '.repeat(25)+'Approval withdrawn. Read complete evidence.';
 writeFileSync(join(workspace,'evidence.txt'),body);
 save(store,'plan.md','Generic meeting notes',{record:record('Meeting'),evidence:['evidence.txt']});
 const listed=knowledge.find({});assert.equal(listed.detail,'compact');
 assert.equal(listed.results[0].match,undefined);assert.equal(listed.results[0].sources,undefined);
 const fullList=knowledge.find({detail:'full'});assert.ok(fullList.results[0].excerpt);assert.ok(Array.isArray(fullList.results[0].sources));
 const found=knowledge.find({query:'Orchid'}),r=found.results[0];
 assert.equal(found.detail,'concise');assert.deepEqual(r.matched,['source']);
 assert.equal(r.match.source,'evidence.txt');assert.equal(r.match.excerpt.truncated,true);
 assert.ok(r.match.excerpt.text.includes('Orchid'));assert.ok(!r.match.excerpt.text.includes('withdrawn'));
 assert.ok(knowledge.read({context:r.context,version:r.version,source:r.match.source}).text.includes('withdrawn'));
 assert.equal(found.coverage.freshness,'not_checked');assert.equal(found.skippedEvidenceBodies,0);
 assert.equal(knowledge.find({query:'Orchid',detail:'compact'}).results[0].match,undefined);
 assert.ok(knowledge.find({query:'Orchid',detail:'full'}).results[0].sources[0].excerpt.text.includes('withdrawn'));
 assert.throws(()=>knowledge.find({detail:'unknown'}));
});

test('concise find handles record-only, path-only and capture-only matches with complete locators',t=>{
 const {store,knowledge}=fixture(t);
 save(store,'scope.md','Ordinary notes',{record:{...record('Meeting'),scope:'UniqueScope '+ 'x'.repeat(200)}});
 save(store,'UniquePath.md','Ordinary notes');
 save(store,'capture.md','Ordinary notes',{captures:[{id:'report',label:'Selected report',representation:'extracted-text',basis:'A selected paragraph',scope:'This project',base64:Buffer.from('UniqueCapture approval withheld.').toString('base64')}]});
 const scope=knowledge.find({query:'UniqueScope'}).results[0];
 assert.equal(scope.match.kind,'record');assert.equal(scope.match.field,'scope');assert.equal(scope.record.scopeTruncated,true);
 assert.equal(knowledge.find({query:'UniquePath'}).results[0].match.kind,'context');
 const c=knowledge.find({query:'UniqueCapture'}).results[0];assert.deepEqual(c.matched,['capture']);assert.equal(c.match.capture,'report');
 assert.ok(knowledge.read({context:c.context,version:c.version,capture:c.match.capture}).text.includes('withheld'));
});

test('concise source omission and pagination retain exact full-result identities',t=>{
 const {workspace,store,knowledge}=fixture(t),evidence=[];
 for(let i=0;i<6;i++){const path=`evidence-${i}.txt`;writeFileSync(join(workspace,path),'Orchid selected support '+i);evidence.push(path);}
 save(store,'a.md','Orchid summary',{evidence});save(store,'b.md','Orchid other context');
 const concise=knowledge.find({query:'Orchid',limit:1}),full=knowledge.find({query:'Orchid',limit:1,detail:'full'});
 assert.deepEqual(concise.next,full.next);assert.equal(concise.results[0].version,full.results[0].version);
 const all=knowledge.find({query:'Orchid'}).results.find(r=>r.context==='a.md');assert.equal(all.moreSourceMatches,5);
 assert.equal(knowledge.find({query:'Orchid',detail:'full'}).results.find(r=>r.context==='a.md').moreSourceMatches,2);
 const next=knowledge.find({query:'Orchid',limit:1,cursor:concise.next});assert.notEqual(next.results[0].context,concise.results[0].context);
 assert.equal(JSON.stringify(knowledge.find({query:'Orchid',detail:'compact'})).includes('selected support'),false);
});
