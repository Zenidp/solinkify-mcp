#!/usr/bin/env node
// Solinkify MCP server over stdio. stdout carries the MCP protocol, so every
// stray log (the gate SDK narrates its payment steps) is rerouted to stderr.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

const server = createServer();
await server.connect(new StdioServerTransport());
console.error('[solinkify-mcp] server ready (stdio)');
