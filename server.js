const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const HOST = 'localhost';
const WORKSPACE_DIR = __dirname;
const TRANSCRIPTS_DIR = path.join(WORKSPACE_DIR, 'transcripts');
const PUBLIC_DIR = path.join(WORKSPACE_DIR, 'public');

// Global state for negotiation runner
let activeProcess = null;
let negotiationState = {
  status: 'idle', // 'idle' | 'running' | 'completed' | 'failed' | 'stopped'
  startTime: null,
  endTime: null,
  instruction: 'Negotiate with vendor.negotiator11@gmail.com for 100 units of Widget X, budget cap $50',
  logs: [],
  summary: null,
  transcriptPath: null,
  transcriptFilename: null
};

// SSE connected clients
const sseClients = new Set();

function broadcastEvent(type, payload) {
  const message = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(message);
    } catch (err) {
      sseClients.delete(client);
    }
  }
}

function appendLog(text, stream = 'stdout') {
  const entry = {
    id: Date.now() + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    text,
    stream
  };
  negotiationState.logs.push(entry);
  if (negotiationState.logs.length > 2000) {
    negotiationState.logs.shift();
  }
  broadcastEvent('log', entry);
  parseLogForSummary(text);
}

/**
 * Parse output lines from buyer-agent to build summary incrementally
 */
function parseLogForSummary(text) {
  if (!text) return;
  const lines = text.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Transcript file path detection
    const transcriptMatch = line.match(/Negotiation transcript saved to markdown file:\s*(.+)$/i);
    if (transcriptMatch) {
      const fullPath = transcriptMatch[1].trim();
      negotiationState.transcriptPath = fullPath;
      negotiationState.transcriptFilename = path.basename(fullPath);
      broadcastEvent('transcript_ready', {
        path: fullPath,
        filename: path.basename(fullPath)
      });
    }

    // Status: DEAL ACCEPTED or WALK_AWAY
    if (line.startsWith('Status:')) {
      if (!negotiationState.summary) negotiationState.summary = {};
      const statusVal = line.replace('Status:', '').trim();
      negotiationState.summary.status = statusVal;
      broadcastEvent('summary_update', negotiationState.summary);
    }

    // Product
    if (line.startsWith('Product:')) {
      if (!negotiationState.summary) negotiationState.summary = {};
      negotiationState.summary.product = line.replace('Product:', '').trim();
      broadcastEvent('summary_update', negotiationState.summary);
    }

    // Price Per Unit
    if (line.startsWith('Price Per Unit:')) {
      if (!negotiationState.summary) negotiationState.summary = {};
      negotiationState.summary.pricePerUnit = line.replace('Price Per Unit:', '').trim();
      broadcastEvent('summary_update', negotiationState.summary);
    }

    // Units
    if (line.startsWith('Units:')) {
      if (!negotiationState.summary) negotiationState.summary = {};
      negotiationState.summary.units = line.replace('Units:', '').trim();
      broadcastEvent('summary_update', negotiationState.summary);
    }

    // Total Price
    if (line.startsWith('Total Price:')) {
      if (!negotiationState.summary) negotiationState.summary = {};
      negotiationState.summary.totalPrice = line.replace('Total Price:', '').trim();
      broadcastEvent('summary_update', negotiationState.summary);
    }

    // Budget Cap
    if (line.startsWith('Budget Cap:')) {
      if (!negotiationState.summary) negotiationState.summary = {};
      negotiationState.summary.budgetCap = line.replace('Budget Cap:', '').trim();
      broadcastEvent('summary_update', negotiationState.summary);
    }

    // Vendor
    if (line.startsWith('Vendor:')) {
      if (!negotiationState.summary) negotiationState.summary = {};
      negotiationState.summary.vendor = line.replace('Vendor:', '').trim();
      broadcastEvent('summary_update', negotiationState.summary);
    }

    // Buyer Mailbox
    if (line.startsWith('Buyer Mailbox:')) {
      if (!negotiationState.summary) negotiationState.summary = {};
      negotiationState.summary.buyerMailbox = line.replace('Buyer Mailbox:', '').trim();
      broadcastEvent('summary_update', negotiationState.summary);
    }

    // Wallet Status
    if (line.startsWith('Wallet Status:')) {
      if (!negotiationState.summary) negotiationState.summary = {};
      negotiationState.summary.walletStatus = line.replace('Wallet Status:', '').trim();
      broadcastEvent('summary_update', negotiationState.summary);
    }
  }
}

/**
 * Start child process running buyer-agent.js
 */
function startNegotiation(instruction) {
  if (activeProcess) {
    throw new Error('A negotiation is already running. Please wait or stop it first.');
  }

  const customInstruction = instruction && instruction.trim()
    ? instruction.trim()
    : 'Negotiate with vendor.negotiator11@gmail.com for 100 units of Widget X, budget cap $50';

  negotiationState.status = 'running';
  negotiationState.startTime = new Date().toISOString();
  negotiationState.endTime = null;
  negotiationState.instruction = customInstruction;
  negotiationState.logs = [];
  negotiationState.summary = null;
  negotiationState.transcriptPath = null;
  negotiationState.transcriptFilename = null;

  broadcastEvent('start', {
    instruction: customInstruction,
    startTime: negotiationState.startTime
  });

  appendLog(`[Dashboard Server] Spawning child process: node buyer-agent.js...`);
  appendLog(`[Dashboard Server] Instruction: "${customInstruction}"`);

  const env = {
    ...process.env,
    BUYER_INSTRUCTION: customInstruction
  };

  const child = spawn(process.execPath, [path.join(WORKSPACE_DIR, 'buyer-agent.js')], {
    cwd: WORKSPACE_DIR,
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  activeProcess = child;

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    appendLog(text, 'stdout');
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    appendLog(text, 'stderr');
  });

  child.on('error', (err) => {
    appendLog(`[Dashboard Server] Child process error: ${err.message}`, 'stderr');
    negotiationState.status = 'failed';
    negotiationState.endTime = new Date().toISOString();
    activeProcess = null;
    broadcastEvent('done', {
      status: 'failed',
      error: err.message,
      summary: negotiationState.summary
    });
  });

  child.on('close', (code, signal) => {
    activeProcess = null;
    negotiationState.endTime = new Date().toISOString();

    if (signal === 'SIGTERM' || signal === 'SIGINT') {
      negotiationState.status = 'stopped';
      appendLog(`[Dashboard Server] Process terminated by user (${signal}).`);
    } else if (code === 0) {
      negotiationState.status = 'completed';
      appendLog(`[Dashboard Server] Process completed successfully (exit code ${code}).`);
    } else {
      negotiationState.status = 'failed';
      appendLog(`[Dashboard Server] Process exited with error code ${code}.`, 'stderr');
    }

    // Try finding newest transcript file if not captured in stdout
    if (!negotiationState.transcriptFilename) {
      try {
        if (fs.existsSync(TRANSCRIPTS_DIR)) {
          const files = fs.readdirSync(TRANSCRIPTS_DIR)
            .filter((f) => f.endsWith('.md'))
            .map((f) => ({
              file: f,
              mtime: fs.statSync(path.join(TRANSCRIPTS_DIR, f)).mtimeMs
            }))
            .sort((a, b) => b.mtime - a.mtime);

          if (files.length > 0) {
            negotiationState.transcriptFilename = files[0].file;
            negotiationState.transcriptPath = path.join(TRANSCRIPTS_DIR, files[0].file);
          }
        }
      } catch (err) {
        // Ignore file scan error
      }
    }

    broadcastEvent('done', {
      status: negotiationState.status,
      code,
      summary: negotiationState.summary,
      transcriptFilename: negotiationState.transcriptFilename,
      transcriptPath: negotiationState.transcriptPath
    });
  });

  return { ok: true, status: 'running', instruction: customInstruction };
}

/**
 * Stop active process
 */
function stopNegotiation() {
  if (!activeProcess) {
    return { ok: false, message: 'No negotiation currently running.' };
  }
  activeProcess.kill('SIGTERM');
  return { ok: true, message: 'Termination signal sent.' };
}

// ============================================================================
// HTTP REQUEST ROUTING
// ============================================================================

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || HOST}`);
  const pathname = reqUrl.pathname;

  // Enable CORS for local convenience
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. SSE Stream: /api/events or /api/stream
  if (pathname === '/api/events' || pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write('\n');

    // Send initial snapshot
    const initialPayload = {
      type: 'init',
      state: {
        status: negotiationState.status,
        startTime: negotiationState.startTime,
        endTime: negotiationState.endTime,
        instruction: negotiationState.instruction,
        summary: negotiationState.summary,
        transcriptFilename: negotiationState.transcriptFilename,
        transcriptPath: negotiationState.transcriptPath,
        logs: negotiationState.logs.slice(-300) // send recent logs
      }
    };
    res.write(`event: init\ndata: ${JSON.stringify(initialPayload)}\n\n`);

    sseClients.add(res);

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // 2. Start negotiation: POST /api/negotiate or POST /api/start
  if ((pathname === '/api/negotiate' || pathname === '/api/start') && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        let payload = {};
        if (body.trim()) {
          payload = JSON.parse(body);
        }
        const result = startNegotiation(payload.instruction);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // 3. Stop negotiation: POST /api/stop or POST /api/kill
  if ((pathname === '/api/stop' || pathname === '/api/kill') && req.method === 'POST') {
    const result = stopNegotiation();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // 4. Status endpoint: GET /api/status
  if (pathname === '/api/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: negotiationState.status,
      startTime: negotiationState.startTime,
      endTime: negotiationState.endTime,
      instruction: negotiationState.instruction,
      summary: negotiationState.summary,
      transcriptFilename: negotiationState.transcriptFilename,
      logCount: negotiationState.logs.length
    }));
    return;
  }

  // 5. List transcripts: GET /api/transcripts
  if (pathname === '/api/transcripts' && req.method === 'GET') {
    try {
      if (!fs.existsSync(TRANSCRIPTS_DIR)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ transcripts: [] }));
        return;
      }
      const files = fs.readdirSync(TRANSCRIPTS_DIR)
        .filter((f) => f.endsWith('.md'))
        .map((f) => {
          const stat = fs.statSync(path.join(TRANSCRIPTS_DIR, f));
          return {
            filename: f,
            mtime: stat.mtime,
            size: stat.size
          };
        })
        .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ transcripts: files }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 6. Transcript content endpoint: GET /transcripts/:filename or GET /api/transcript/:filename
  const transcriptMatch = pathname.match(/^\/(?:api\/transcript|transcripts)\/([^/]+)$/);
  if (transcriptMatch && req.method === 'GET') {
    const safeFilename = path.basename(decodeURIComponent(transcriptMatch[1]));
    const filePath = path.join(TRANSCRIPTS_DIR, safeFilename);

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Transcript file not found');
      return;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      if (reqUrl.searchParams.get('format') === 'json') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ filename: safeFilename, content }));
      } else {
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `inline; filename="${safeFilename}"`
        });
        res.end(content);
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Error reading transcript: ${err.message}`);
    }
    return;
  }

  // 7. Serve Index HTML: GET / or GET /index.html
  if (pathname === '/' || pathname === '/index.html') {
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(indexPath).pipe(res);
      return;
    }
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Dashboard index.html not found');
    return;
  }

  // 8. Serve static files from public/
  const staticPath = path.join(PUBLIC_DIR, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  if (fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
    const ext = path.extname(staticPath).toLowerCase();
    const mimeTypes = {
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.json': 'application/json'
    };
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    fs.createReadStream(staticPath).pipe(res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

function startServer(port = PORT) {
  return new Promise((resolve, reject) => {
    server.listen(port, HOST, () => {
      console.log(`[Dashboard Server] Running at http://${HOST}:${port}/`);
      resolve(server);
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`[Dashboard Server] Port ${port} in use, trying ${port + 1}...`);
        server.listen(port + 1, HOST, () => {
          console.log(`[Dashboard Server] Running at http://${HOST}:${port + 1}/`);
          resolve(server);
        });
      } else {
        reject(err);
      }
    });
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  server,
  startServer,
  startNegotiation,
  stopNegotiation,
  negotiationState
};
