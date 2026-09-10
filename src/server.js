import { createServer } from 'node:http';
createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end('{"service":"wind-maintenance","status":"running"}'); }).listen(Number(process.env.PORT || 8080));
