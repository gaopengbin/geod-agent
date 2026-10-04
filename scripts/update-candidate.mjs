/** Offline review of Tauri signatures using Node's Ed25519 and BLAKE2b primitives.
 * The installed application continues to use the official Tauri updater verifier.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash,createPublicKey,verify} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const b64=value=>{const text=value.trim();if(!/^[A-Za-z0-9+/]+={0,2}$/.test(text))throw new Error('Invalid base64');const data=Buffer.from(text,'base64');if(data.toString('base64')!==text)throw new Error('Non-canonical base64');return data;};
export async function verifySignedFile(file,publicKey,signature,version){
  const keyLines=b64(publicKey).toString('utf8').trim().split(/\r?\n/),lines=b64(signature).toString('utf8').trim().split(/\r?\n/);
  if(keyLines.length!==2||lines.length!==4||!keyLines[0].startsWith('untrusted comment:')||!lines[2].startsWith('trusted comment: '))throw new Error('Invalid minisign document');
  const key=b64(keyLines[1]),packet=b64(lines[1]),global=b64(lines[3]);
  if(key.length!==42||packet.length!==74||global.length!==64||!['Ed','ED'].includes(key.subarray(0,2).toString())||packet.subarray(0,2).toString()!=='ED')throw new Error('Unsupported minisign packet');
  if(!key.subarray(2,10).equals(packet.subarray(2,10)))throw new Error('Signing key does not match');
  const ed25519=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),key.subarray(10)]),format:'der',type:'spki'});
  const hash=createHash('blake2b512'),sha=createHash('sha256');let bytes=0;
  for await(const chunk of fs.createReadStream(file)){hash.update(chunk);sha.update(chunk);bytes+=chunk.length;}
  const comment=lines[2].slice('trusted comment: '.length);
  if(!verify(null,hash.digest(),ed25519,packet.subarray(10))||!verify(null,Buffer.concat([packet.subarray(10),Buffer.from(comment,'utf8')]),ed25519,global))throw new Error('Update signature does not verify');
  if(comment.split('\t').find(field=>field.startsWith('version:'))!==`version:${version}`)throw new Error('Signed version does not match the manifest');
  return{bytes,sha256:sha.digest('hex'),signedVersion:version,publicKeyFingerprint:createHash('sha256').update(key).digest('hex')};
}
export function updateManifest(version,signature,downloadBase,fileName,notes=''){
  if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version))throw new Error('A valid release version is required');
  const base=new URL(downloadBase);if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw new Error('Update download base must be HTTPS without credentials');
  base.pathname=base.pathname.replace(/\/$/,'')+'/'+encodeURIComponent(fileName);
  return{version,notes,pub_date:new Date().toISOString(),platforms:{'windows-x86_64':{signature,url:base.href}}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const [file,version,downloadBase,output]=process.argv.slice(2);if(!file||!version||!downloadBase||!output)throw new Error('Provide installer, version, HTTPS download base and output directory');
    const publicKey=process.env.GEOD_UPDATE_PUBLIC_KEY;if(!publicKey)throw new Error('The build public key is missing');
    const signature=fs.readFileSync(file+'.sig','utf8').trim(),verified=await verifySignedFile(file,publicKey,signature,version),manifest=updateManifest(version,signature,downloadBase,path.basename(file));
    fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'latest.json'),JSON.stringify(manifest,null,2));
    fs.writeFileSync(path.join(output,'update-verification.json'),JSON.stringify({...verified,installer:path.basename(file),url:manifest.platforms['windows-x86_64'].url,published:false},null,2));
    console.log(JSON.stringify({verified:true,...verified,published:false}));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
