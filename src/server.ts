import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Connection } from '@solana/web3.js';
import { loadConfig } from './config.js';
import { loadWallet } from './wallet.js';
import { SpendGuard } from './guard.js';
import type { ToolContext } from './context.js';
import { registerWalletTools } from './tools/wallet.js';
import { registerGateTools } from './tools/gate.js';
import { registerDatahubTools } from './tools/datahub.js';
import { registerPayTools } from './tools/pay.js';
import { registerSocialTools } from './tools/social.js';

export const SERVER_VERSION = '0.2.2';

/** Build the Solinkify MCP server with all pillar tools registered. */
export function createServer(): McpServer {
  const config = loadConfig();
  const ctx: ToolContext = {
    config,
    wallet: loadWallet(),
    connection: new Connection(config.rpcUrl, 'confirmed'),
    guard: new SpendGuard(config.maxPaymentUsd, config.dailyCapUsd),
  };

  const server = new McpServer({ name: 'solinkify', version: SERVER_VERSION });
  registerWalletTools(server, ctx);
  registerGateTools(server, ctx);
  registerDatahubTools(server, ctx);
  registerPayTools(server, ctx);
  registerSocialTools(server, ctx);
  return server;
}
