import http from 'node:http';
import {readFile} from 'node:fs/promises';
const routes={'/':'nina.html','/nina.html':'nina.html','/index.html':'index.html'};
http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('X-Frame-Options','DENY');res.setHeader('Strict-Transport-Security','max-age=31536000');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');res.setHeader('Cache-Control','no-store');
 if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);return res.end();}
 const path=new URL(req.url,'http://localhost').pathname;
 if(path==='/health'||path==='/ready'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({ok:true,version:'Mission Control v1.2.2',commit:process.env.RENDER_GIT_COMMIT||null,at:new Date().toISOString()}));}
 if(!routes[path]){res.writeHead(404);return res.end('Not found');}
 try{const body=await readFile(new URL(routes[path],import.meta.url));res.setHeader('Content-Type','text/html; charset=utf-8');res.end(req.method==='HEAD'?undefined:body);}catch{res.writeHead(503);res.end('Unavailable');}
}).listen(process.env.PORT||10000,'0.0.0.0');
