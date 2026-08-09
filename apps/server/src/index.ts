import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from './db.js';
import { createServer } from './server.js';

const dataDir=resolve(process.env.SPEED_DIAL_DATA_DIR ?? 'data');
const tokenFile=resolve(dataDir,'api-token');
function loadToken() { if (process.env.SPEED_DIAL_API_TOKEN) return process.env.SPEED_DIAL_API_TOKEN; if (existsSync(tokenFile)) return readFileSync(tokenFile,'utf8').trim(); const token=randomBytes(32).toString('base64url'); writeFileSync(tokenFile,token,{mode:0o600}); chmodSync(tokenFile,0o600); return token; }
const token=loadToken();
const store=new Store(resolve(dataDir,'speed-dial.sqlite'));
const app=createServer({store,token});
app.addHook('onClose', async () => store.close());
const port=Number(process.env.PORT ?? 3721);
await app.listen({host:'127.0.0.1',port});
console.log(`Speed Dial API listening on http://127.0.0.1:${port}`);
console.log(`Pair extension with bearer token from ${tokenFile}`);
