/**
 * MCP Gateway - HTTP API for tools
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import * as tools from '../tools/index.js';

export interface GatewayConfig {
  port: number;
  cwd: string;
  zaiApiKey?: string;
  tavilyApiKey?: string;
}

export function createGateway(config: GatewayConfig) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }
    
    const url = new URL(req.url || '/', `http://localhost:${config.port}`);
    
    // Health
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', cwd: config.cwd }));
      return;
    }
    
    // List tools
    if (url.pathname === '/tools' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tools: tools.definitions }));
      return;
    }
    
    // Execute tool
    if (url.pathname === '/execute' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { tool, arguments: args } = JSON.parse(body);
          
          const result = await tools.execute(tool, args || {}, {
            cwd: config.cwd,
            sessionId: 'gateway',
            zaiApiKey: config.zaiApiKey,
            tavilyApiKey: config.tavilyApiKey,
          });
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    }
    
    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });
  
  return {
    start: () => {
      server.listen(config.port, '0.0.0.0', () => {
        console.log(`Gateway on http://0.0.0.0:${config.port}`);
        console.log(`CWD: ${config.cwd}`);
        console.log(`Tools: ${tools.toolNames.join(', ')}`);
      });
    },
    stop: () => server.close(),
  };
}
