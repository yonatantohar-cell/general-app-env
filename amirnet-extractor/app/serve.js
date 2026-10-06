/* Tiny static server for local browser checks. Declares UTF-8, which
   python's http.server does not, so Hebrew string literals render correctly. */
const http=require('http'), fs=require('fs'), path=require('path');
const TYPES={'.html':'text/html; charset=utf-8','.json':'application/json; charset=utf-8','.js':'text/javascript; charset=utf-8'};
http.createServer((req,res)=>{
  const rel=decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/,'')||'exam.html';
  const file=path.join(__dirname, rel);
  fs.readFile(file,(err,data)=>{
    if(err){res.writeHead(404);return res.end('not found')}
    res.writeHead(200,{'Content-Type':TYPES[path.extname(file)]||'application/octet-stream'});
    res.end(data);
  });
}).listen(8731,'127.0.0.1',()=>console.log('serving on 8731'));
