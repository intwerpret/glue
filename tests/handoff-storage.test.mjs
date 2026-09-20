import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {atomicWrite} from '../dist/storage.js';
function fixture(t){const dir=fs.mkdtempSync(join(tmpdir(),'glue-atomic-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
for(const failure of ['writeFileSync','renameSync'])test('atomic write cleans its own temporary file after '+failure+' fails',t=>{
 const dir=fixture(t),target=join(dir,'file.md');fs.writeFileSync(target,'original');fs.writeFileSync(target+'.tmp','unrelated');
 const original=fs[failure],error=new Error('injected '+failure);
 try {
  fs[failure]=()=>{throw error;};syncBuiltinESMExports();
  assert.throws(()=>atomicWrite(target,'replacement'),e=>e===error);
 } finally {fs[failure]=original;syncBuiltinESMExports();}
 assert.equal(fs.readFileSync(target,'utf8'),'original');assert.equal(fs.readFileSync(target+'.tmp','utf8'),'unrelated');
 assert.deepEqual(fs.readdirSync(dir).sort(),['file.md','file.md.tmp']);
});
test('failed exclusive temporary creation preserves the colliding file',t=>{
 const dir=fixture(t),target=join(dir,'file.md');fs.writeFileSync(target,'original');
 const original=fs.openSync;let collision;
 try {
  fs.openSync=(file,flags,...args)=>{
   assert.equal(flags,'wx');collision=file;
   const fd=original(file,'wx',0o600);fs.writeFileSync(fd,'Other owner');fs.closeSync(fd);
   return original(file,flags,...args);
  };syncBuiltinESMExports();
  assert.throws(()=>atomicWrite(target,'replacement'),{code:'EEXIST'});
 } finally {fs.openSync=original;syncBuiltinESMExports();}
 assert.equal(fs.readFileSync(collision,'utf8'),'Other owner');assert.equal(fs.readFileSync(target,'utf8'),'original');
});
