import { afterEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
let root:string;
afterEach(async()=>{if(root)await rm(root,{recursive:true,force:true});});

it('concurrent standalone hook processes publish complete private receipts while Vowe is absent',async()=>{
 root=await mkdtemp(path.join(os.tmpdir(),'vowe-collector-'));
 await Promise.all(Array.from({length:8},(_,i)=>new Promise<void>((resolve,reject)=>{
   const child=spawn(process.execPath,[fileURLToPath(new URL('../src/collector.ts',import.meta.url)),root],{stdio:['pipe','pipe','pipe']});
   let output='';child.stdout.on('data',b=>output+=b);child.once('error',reject);
   child.once('exit',code=>{try{expect(code).toBe(0);expect(output).toBe('{}');resolve();}catch(e){reject(e);}});
   child.stdin.end(JSON.stringify({conversation_id:'probe',hook_event_name:'afterAgentThought',text:`thought ${i}`}));
 })));
 const files=await readdir(root);expect(files).toHaveLength(8);expect(files.every(f=>f.endsWith('.json'))).toBe(true);
 const records=await Promise.all(files.map(f=>readFile(path.join(root,f),'utf8').then(t=>JSON.parse(t))));
 expect(new Set(records.map(r=>r.id)).size).toBe(8);expect(new Set(records.map(r=>r.payload.text)).size).toBe(8);
 for(const record of records)expect(JSON.parse(record.raw)).toEqual(record.payload);
});
