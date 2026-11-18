'use strict';
// Executes the real preference/IPC functions with only Electron's window shell
// stubbed. All filesystem round trips use this check's own fresh temp directory.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),os=require('node:os');
const root=path.resolve(__dirname,'..');
const {sanitizePreferences,sanitizeCollectedRooms,PREFERENCES_FILE_LIMIT}=require('../desktop/policy.cjs');
const main=fs.readFileSync(path.join(root,'desktop/main.cjs'),'utf8');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'collection-roundtrip-')),prefsFile=path.join(dir,'preferences.json');
const handlers=new Map(),logs=[],frame={url:'file://fixture'},contents={mainFrame:frame};
const context={fs,path,process,Buffer,JSON,Set,clearTimeout,setTimeout,setImmediate,PREFERENCES_FILE_LIMIT,sanitizePreferences,sanitizeCollectedRooms,preferences:sanitizePreferences({pinned:true}),preferencesWarning:false,RUNTIME:dir,PREFS_FILE:prefsFile,saveTimer:null,log:s=>logs.push(s),mainWindow:{isDestroyed:()=>false,webContents:contents},target:{},isAllowedNavigation:()=>true,rememberBounds:()=>{},ipcMain:{handle:(key,fn)=>handlers.set(key,fn)},state:()=>({}),observerEnvelope:()=>({}),setPinned:()=>({}),setExpanded:()=>({}),hideWindow:()=>({}),app:{quit:()=>{}}};
vm.createContext(context);
vm.runInContext(main.slice(main.indexOf('function readPreferences()'),main.indexOf('function rememberBounds()'))+main.slice(main.indexOf('function savePreferences()'),main.indexOf('function state()'))+main.slice(main.indexOf('function trustedSender('),main.indexOf('function fatal('))+'\nregisterIPC();',context);
const event={sender:contents,senderFrame:frame};
const invoke=(name,...args)=>handlers.get('shipboss:'+name)(event,...args);
const cases=[];
for(const [label,fill] of [['ascii','z'],['three-byte','界'],['surrogate-pair','𠮷']]){
 const ids=prefix=>Array.from({length:256},(_,i)=>{
  const head=prefix+i.toString().padStart(3,'0');return (head+fill.repeat(160)).slice(0,160);
 });
 const demo=ids('d'),bridge=ids('b');
 assert.equal(invoke('set-collected-rooms','demo',demo).ok,true,label+' demo save');
 assert.equal(invoke('set-collected-rooms','bridge',bridge).ok,true,label+' bridge save');
 const bytes=fs.statSync(prefsFile).size,readback=context.readPreferences();
 assert.ok(bytes<=PREFERENCES_FILE_LIMIT,label+' actual serialized bytes fit reader');
 assert.deepEqual(Array.from(readback.collections.demo),demo,label+' demo reload');
 assert.deepEqual(Array.from(readback.collections.bridge),bridge,label+' bridge reload');
 assert.equal(readback.pinned,true,'unrelated preferences preserved');
 cases.push({label,bytes,idsPerScope:256});
}
const before=fs.readFileSync(prefsFile);
for(const args of [['bridge',['a','a']],['invalid',[]],['bridge',Array.from({length:257},(_,i)=>'r'+i)],['bridge',['x'.repeat(161)]]])assert.throws(()=>invoke('set-collected-rooms',...args));
assert.throws(()=>invoke('set-pinned','true'));assert.throws(()=>invoke('set-expanded',true,false));
assert.deepEqual(fs.readFileSync(prefsFile),before,'invalid requests leave actual persisted data unchanged');
context.preferences.unexpected='x'.repeat(PREFERENCES_FILE_LIMIT);
const previousIds=Array.from(context.preferences.collections.bridge);
assert.equal(invoke('set-collected-rooms','bridge',['replacement']).ok,false,'oversized serialization rejected before write');
assert.deepEqual(Array.from(context.preferences.collections.bridge),previousIds,'failed save restores in-memory choices');
assert.deepEqual(fs.readFileSync(prefsFile),before,'oversized serialization keeps old file intact');
delete context.preferences.unexpected;
const staging=path.resolve(dir,`preferences-${process.pid}.tmp`);
assert.equal(path.dirname(staging),path.resolve(dir));fs.mkdirSync(staging);
assert.equal(invoke('set-collected-rooms','bridge',['io-failure']).ok,false,'real staging IO failure reports unsuccessful persistence');
assert.deepEqual(fs.readFileSync(prefsFile),before);
assert.deepEqual(Array.from(context.preferences.collections.bridge),previousIds);
// Keep temp evidence, including the intentionally blocked staging directory.
console.log(JSON.stringify({passed:true,fileLimit:PREFERENCES_FILE_LIMIT,cases,rejectedOversizeAtomically:true,ioFailurePreservesOldData:true,strictArguments:true,temporaryEvidence:dir}));
