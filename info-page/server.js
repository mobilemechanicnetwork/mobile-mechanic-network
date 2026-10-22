// Serves the Mobile Mechanic Network mechanic info page (single static file).
// Runs as its own Railway service with the custom domain mobilemechanicinmyarea.com.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'index.html');

const server = http.createServer((req, res) => {
  fs.readFile(INDEX, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('Page unavailable.');
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': data.length,
      'Cache-Control': 'public, max-age=300',
    });
    res.end(data);
  });
});

server.listen(PORT, () => console.log('info page listening on ' + PORT));
