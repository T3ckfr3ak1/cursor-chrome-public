#!/usr/bin/env node
'use strict';

/**
 * Cursor-Chrome MCP server (stdio JSON-RPC subset for Cursor).
 * Tools mirror the Node client against http://127.0.0.1:9222
 *
 * Run: node mcp/server.js
 * Or:  npm run mcp
 */

const { CursorChrome } = require('../src/client');

const chrome = new CursorChrome();

const TOOLS = [
  {
    name: 'cursor_chrome_health',
    description: 'Check if Cursor-Chrome agent API is up',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'cursor_chrome_claim',
    description: 'Claim or create a tab for a threadId (max 20 tabs)',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        url: { type: 'string' },
        profile: { type: 'string', description: 'shared|work|personal|isolated' },
        isolate: { type: 'boolean' },
      },
      required: ['threadId'],
    },
  },
  {
    name: 'cursor_chrome_navigate',
    description: 'Navigate a tab to a URL',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string' }, url: { type: 'string' } },
      required: ['tabId', 'url'],
    },
  },
  {
    name: 'cursor_chrome_act',
    description: 'Run multi-step act DSL (click/type/wait/navigate/snapshot)',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string' }, body: { type: 'object' } },
      required: ['tabId'],
    },
  },
  {
    name: 'cursor_chrome_snapshot',
    description: 'Accessibility / text snapshot of the page',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string' }, opts: { type: 'object' } },
      required: ['tabId'],
    },
  },
  {
    name: 'cursor_chrome_click',
    description: 'Click by selector or coordinates (optional iframe)',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        selector: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        iframe: { type: 'string' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'cursor_chrome_type',
    description: 'Type into an element',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        clear: { type: 'boolean' },
        iframe: { type: 'string' },
      },
      required: ['tabId', 'text'],
    },
  },
  {
    name: 'cursor_chrome_evaluate',
    description: 'Evaluate JavaScript in the page',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string' }, expression: { type: 'string' } },
      required: ['tabId', 'expression'],
    },
  },
  {
    name: 'cursor_chrome_drop_files',
    description: 'Drop files / set file input (AAB uploads etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        selector: { type: 'string' },
        mode: { type: 'string' },
      },
      required: ['tabId', 'files'],
    },
  },
  {
    name: 'cursor_chrome_handoff',
    description: 'Hand control to human for login/2FA; optionally wait for Done',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        reason: { type: 'string' },
        message: { type: 'string' },
        wait: { type: 'boolean' },
        timeoutMs: { type: 'number' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'cursor_chrome_guide',
    description:
      'Show/update the right-side instruction sidebar (title, body, numbered steps). Prefer this over dumping checklists in chat.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        subtitle: { type: 'string' },
        body: { type: 'string' },
        footer: { type: 'string' },
        steps: {
          type: 'array',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  done: { type: 'boolean' },
                  detail: { type: 'string' },
                },
              },
            ],
          },
        },
        open: { type: 'boolean' },
        width: { type: 'number' },
        clear: { type: 'boolean', description: 'If true, clear and hide the guide' },
      },
    },
  },
  {
    name: 'cursor_chrome_guide_clear',
    description: 'Clear and hide the instruction sidebar',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'cursor_chrome_click_text',
    description:
      'Click by visible label (prefers dialogs). Refuses Create/Delete/Halt unless confirmDangerous=true.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        text: { type: 'string' },
        exact: { type: 'boolean' },
        scope: { type: 'string', description: 'auto|dialog|page' },
        confirmDangerous: { type: 'boolean' },
      },
      required: ['tabId', 'text'],
    },
  },
  {
    name: 'cursor_chrome_pick_row',
    description: 'Select a table/dialog row containing text (checkbox preferred)',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        contains: { type: 'string' },
        click: { type: 'string', description: 'checkbox|row' },
      },
      required: ['tabId', 'contains'],
    },
  },
  {
    name: 'cursor_chrome_navigate_retry',
    description: 'Navigate with retries + SPA stable wait; fails on Play unexpected-error pages',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        url: { type: 'string' },
        retries: { type: 'number' },
        mustInclude: { type: 'string' },
      },
      required: ['tabId', 'url'],
    },
  },
  {
    name: 'cursor_chrome_auto_handoff',
    description: 'If auth wall detected, start handoff automatically',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string' }, wait: { type: 'boolean' } },
      required: ['tabId'],
    },
  },
  {
    name: 'cursor_chrome_watch',
    description: 'Unpark window so human can watch',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string' }, threadId: { type: 'string' } },
    },
  },
  {
    name: 'cursor_chrome_minimize',
    description: 'Park window off-screen (agents keep working)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'cursor_chrome_metrics',
    description: 'Pool metrics, frames, downloads, speed mode',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(name, args = {}) {
  switch (name) {
    case 'cursor_chrome_health':
      return chrome.health();
    case 'cursor_chrome_claim':
      return chrome.claim(args.threadId, {
        url: args.url,
        profile: args.profile,
        isolate: args.isolate,
      });
    case 'cursor_chrome_navigate':
      return chrome.navigate(args.tabId, args.url);
    case 'cursor_chrome_act':
      return chrome.act(args.tabId, args.body || args);
    case 'cursor_chrome_snapshot':
      return chrome.snapshot(args.tabId, args.opts || {});
    case 'cursor_chrome_click':
      return chrome.click(args.tabId, args);
    case 'cursor_chrome_type':
      return chrome.type(args.tabId, args);
    case 'cursor_chrome_evaluate':
      return chrome.evaluate(args.tabId, args.expression);
    case 'cursor_chrome_drop_files':
      return chrome.dropFiles(args.tabId, args);
    case 'cursor_chrome_handoff':
      return chrome.handoff(args.tabId, args);
    case 'cursor_chrome_guide':
      if (args.clear) return chrome.guideClear();
      return chrome.guide(args);
    case 'cursor_chrome_guide_clear':
      return chrome.guideClear();
    case 'cursor_chrome_click_text':
      return chrome.clickText(args.tabId, args);
    case 'cursor_chrome_pick_row':
      return chrome.pickRow(args.tabId, args);
    case 'cursor_chrome_navigate_retry':
      return chrome.navigateRetry(args.tabId, args.url, args);
    case 'cursor_chrome_auto_handoff':
      return chrome.autoHandoff(args.tabId, args);
    case 'cursor_chrome_watch':
      return chrome.watch(args);
    case 'cursor_chrome_minimize':
      return chrome.minimize();
    case 'cursor_chrome_metrics':
      return chrome.metrics();
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function send(msg) {
  const body = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

let buffer = Buffer.alloc(0);

process.stdin.on('data', async (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const header = buffer.slice(0, headerEnd).toString('utf8');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }
    const len = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + len) break;
    const raw = buffer.slice(start, start + len).toString('utf8');
    buffer = buffer.slice(start + len);
    let req;
    try {
      req = JSON.parse(raw);
    } catch {
      continue;
    }
    await handle(req);
  }
});

async function handle(req) {
  const { id, method, params } = req;
  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'cursor-chrome', version: '1.0.0' },
        },
      });
      return;
    }
    if (method === 'notifications/initialized' || method === 'initialized') return;
    if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    }
    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments || {};
      const result = await callTool(name, args);
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        },
      });
      return;
    }
    if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    }
    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  } catch (err) {
    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: err.message || String(err) },
    });
  }
}

process.stdin.resume();
