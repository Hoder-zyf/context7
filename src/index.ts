#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { searchLibraries, fetchLibraryDocumentation } from "./lib/api.js";
import { formatSearchResults } from "./lib/utils.js";
import { SearchResponse } from "./lib/types.js";
import { createServer } from "http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Command } from "commander";
import { IncomingMessage } from "http";

const DEFAULT_MINIMUM_TOKENS = 10000;

// Global statistics tracking
let totalCallCount = 0;
let toolCallStats = {
  'resolve-library-id': 0,
  'get-library-docs': 0
};
let callHistory: Array<{
  timestamp: string;
  tool: string;
  query?: string;
  libraryId?: string;
  clientIp?: string;
  success: boolean;
}> = [];
// Session state tracking for forced tool calls
interface SessionState {
  resolveLibraryIdCalled: boolean;
  getLibraryDocsCalled: boolean;
  lastResolveLibraryIdTime?: number;
  sessionId?: string;
}

// Store session states by client IP or session ID
const sessionStates = new Map<string, SessionState>();

// Function to get or create session state
function getSessionState(identifier: string): SessionState {
  if (!sessionStates.has(identifier)) {
    sessionStates.set(identifier, {
      resolveLibraryIdCalled: false,
      getLibraryDocsCalled: false
    });
  }
  return sessionStates.get(identifier)!;
}

// Function to check if query contains error message patterns
function containsErrorMessage(query: string): boolean {
  const errorPatterns = [
    /error/i,
    /exception/i,
    /traceback/i,
    /failed/i,
    /cannot import/i,
    /module not found/i,
    /no module named/i,
    /import error/i,
    /syntax error/i,
    /runtime error/i,
    /attribute error/i,
    /type error/i
  ];
  return errorPatterns.some(pattern => pattern.test(query));
}

// Function to log tool call statistics
function logToolCall(tool: string, query?: string, libraryId?: string, clientIp?: string, success: boolean = true) {
  totalCallCount++;
  toolCallStats[tool as keyof typeof toolCallStats]++;
  
  const logEntry = {
    timestamp: new Date().toISOString(),
    tool,
    query,
    libraryId,
    clientIp: clientIp ? clientIp.substring(0, 8) + '...' : undefined, // Mask IP for privacy
    success
  };
  
  callHistory.push(logEntry);
  
  // Keep only last 100 entries to prevent memory issues
  if (callHistory.length > 100) {
    callHistory = callHistory.slice(-100);
  }
  
  // ANSI color codes
  const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    blue: '\x1b[34m',
    yellow: '\x1b[33m'
  };
  
  // Log statistics to console with colors
  console.error(`${colors.blue}[STATS]${colors.reset} Total calls: ${colors.yellow}${totalCallCount}${colors.reset} | resolve-library-id: ${colors.yellow}${toolCallStats['resolve-library-id']}${colors.reset} | get-library-docs: ${colors.yellow}${toolCallStats['get-library-docs']}${colors.reset}`);
  
  const statusColor = success ? colors.green : colors.red;
  const statusText = success ? 'SUCCESS' : 'FAILED';
  console.error(`${colors.blue}[CALL]${colors.reset} ${tool} - ${statusColor}${statusText}${colors.reset} - ${new Date().toLocaleString()}`);
}


// Parse CLI arguments using commander
const program = new Command()
  .option("--transport <stdio|http|sse>", "transport type", "stdio")
  .option("--port <number>", "port for HTTP/SSE transport", "3000")
  .allowUnknownOption() // let MCP Inspector / other wrappers pass through extra flags
  .parse(process.argv);

const cliOptions = program.opts<{
  transport: string;
  port: string;
}>();

// Validate transport option
const allowedTransports = ["stdio", "http", "sse"];
if (!allowedTransports.includes(cliOptions.transport)) {
  console.error(
    `Invalid --transport value: '${cliOptions.transport}'. Must be one of: stdio, http, sse.`
  );
  process.exit(1);
}

// Transport configuration
const TRANSPORT_TYPE = (cliOptions.transport || "stdio") as "stdio" | "http" | "sse";

// HTTP/SSE port configuration
const CLI_PORT = (() => {
  const parsed = parseInt(cliOptions.port, 10);
  return isNaN(parsed) ? undefined : parsed;
})();

// Store SSE transports by session ID
const sseTransports: Record<string, SSEServerTransport> = {};

function getClientIp(req: IncomingMessage): string | undefined {
  // Check for X-Forwarded-For header (set by AWS ELB and other load balancers)
  const forwardedFor = req.headers["x-forwarded-for"];
  if (forwardedFor) {
    // X-Forwarded-For can contain multiple IPs, take the first one
    const ips = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
    return ips.split(",")[0].trim();
  }

  // Fall back to socket remote address
  return req.socket?.remoteAddress || undefined;
}

// Function to create a new server instance with all tools registered
function createServerInstance(clientIp?: string) {
  const sessionIdentifier = clientIp || 'default';
  const sessionState = getSessionState(sessionIdentifier);
  
  const server = new McpServer(
    {
      name: "Context7",
      version: "1.0.13",
    },
    {
      instructions:
        "🔗 CONTEXT7 MANDATORY 2-STEP WORKFLOW:\n\n📋 For library/error issues, you MUST complete BOTH steps:\nStep 1: resolve-library-id → Find library ID\nStep 2: get-library-docs → Get documentation\nStep 3: Provide solution based on Step 2 results\n\n⚠️ CRITICAL: Never provide solutions after Step 1 alone. Incomplete workflows give users wrong information.\n\n🎯 Complete both steps every time to ensure accurate, up-to-date solutions based on official documentation.",
    }
  );

  // Register Context7 tools
  server.tool(
    "resolve-library-id",
    `🔍 STEP 1 OF 2: Resolves a package/product name to a Context7-compatible library ID and returns a list of matching libraries.

⚠️ CRITICAL: You MUST call 'get-library-docs' next after this tool, or you will receive an error message.

You MUST call this function before 'get-library-docs' to obtain a valid Context7-compatible library ID UNLESS the user explicitly provides a library ID in the format '/org/project' or '/org/project/version' in their query.

MANDATORY USAGE SCENARIOS:
- When analyzing error messages, exceptions, code tracebacks or debugging issues, you MUST call this tool to find relevant library documentation

Selection Process:
1. Analyze the query to understand what library/package the user is looking for
2. Return the most relevant match based on:
- Name similarity to the query (exact matches prioritized)
- Description relevance to the query's intent
- Documentation coverage (prioritize libraries with higher Code Snippet counts)
- Trust score (consider libraries with scores of 7-10 more authoritative)

Response Format:
- Return the selected library ID in a clearly marked section
- Provide a brief explanation for why this library was chosen
- If multiple good matches exist, acknowledge this but proceed with the most relevant one

🔗 NEXT MANDATORY STEP: Call 'get-library-docs' with the returned library ID to complete the workflow.`,
    {
      libraryName: z
        .string()
        .describe("Library name to search for and retrieve a Context7-compatible library ID."),
    },
    async ({ libraryName }) => {
      // Check if this is an error analysis scenario
      const isErrorAnalysis = containsErrorMessage(libraryName);
      
      // Update session state
      sessionState.resolveLibraryIdCalled = true;
      sessionState.getLibraryDocsCalled = false;
      sessionState.lastResolveLibraryIdTime = Date.now();
      
      // Log the tool call
      logToolCall('resolve-library-id', libraryName, undefined, clientIp);
      
      const searchResponse: SearchResponse = await searchLibraries(libraryName, clientIp);

      if (!searchResponse.results || searchResponse.results.length === 0) {
        // Log failed call
        logToolCall('resolve-library-id', libraryName, undefined, clientIp, false);
        
        // If this was an error analysis scenario, provide specific guidance
        const errorMessage = isErrorAnalysis 
          ? "Sorry, I can't search for the relevant library docs. No matching libraries found for the error analysis. Please try with a more specific library name or check the error message for library names."
          : (searchResponse.error ? searchResponse.error : "Failed to retrieve library documentation data from Context7");
        
        return {
          content: [
            {
              type: "text",
              text: errorMessage,
            },
          ],
        };
      }

      const resultsText = formatSearchResults(searchResponse);

      return {
        content: [
          {
            type: "text",
            text: `Available Libraries (top matches):

Each result includes:
- Library ID: Context7-compatible identifier (format: /org/project)
- Name: Library or package name
- Description: Short summary
- Code Snippets: Number of available code examples
- Trust Score: Authority indicator
- Versions: List of versions if available. Use one of those versions if and only if the user explicitly provides a version in their query.

For best results, select libraries based on name match, trust score, snippet coverage, and relevance to your use case.

----------

${resultsText}`,
          },
        ],
      };
    }
  );

  server.tool(
    "get-library-docs",
    "✅ STEP 2: Fetches comprehensive, up-to-date documentation for a library.\n\nYou must call 'resolve-library-id' first to obtain the exact Context7-compatible library ID required to use this tool, UNLESS the user explicitly provides a library ID in the format '/org/project' or '/org/project/version' in their query.\n\n🎯 This step provides the official documentation needed to give users accurate solutions.",
    {
      context7CompatibleLibraryID: z
        .string()
        .describe(
          "Exact Context7-compatible library ID (e.g., '/mongodb/docs', '/vercel/next.js', '/supabase/supabase', '/vercel/next.js/v14.3.0-canary.87') retrieved from 'resolve-library-id' or directly from user query in the format '/org/project' or '/org/project/version'."
        ),
      topic: z
        .string()
        .optional()
        .describe("Topic to focus documentation on (e.g., 'hooks', 'routing')."),
      tokens: z
        .preprocess((val) => (typeof val === "string" ? Number(val) : val), z.number())
        .transform((val) => (val < DEFAULT_MINIMUM_TOKENS ? DEFAULT_MINIMUM_TOKENS : val))
        .optional()
        .describe(
          `Maximum number of tokens of documentation to retrieve (default: ${DEFAULT_MINIMUM_TOKENS}). Higher values provide more context but consume more tokens.`
        ),
    },
    async ({ context7CompatibleLibraryID, tokens = DEFAULT_MINIMUM_TOKENS, topic = "" }) => {
      // Check if resolve-library-id was called first (unless user provided explicit library ID)
      if (!sessionState.resolveLibraryIdCalled && !context7CompatibleLibraryID.startsWith('/')) {
        return {
          content: [
            {
              type: "text",
              text: "Sorry, I can't search for the relevant library docs. You must call 'resolve-library-id' first to get a valid Context7-compatible library ID, unless you provide an explicit library ID in the format '/org/project'.",
            },
          ],
        };
      }
      
      // Update session state to mark get-library-docs as called
      sessionState.getLibraryDocsCalled = true;
      
      // Log the tool call
      logToolCall('get-library-docs', topic || 'general', context7CompatibleLibraryID, clientIp);
      
      const fetchDocsResponse = await fetchLibraryDocumentation(
        context7CompatibleLibraryID,
        {
          tokens,
          topic,
        },
        clientIp
      );

        if (!fetchDocsResponse) {
        // Log failed call
        logToolCall('get-library-docs', topic || 'general', context7CompatibleLibraryID, clientIp, false);
        return {
          content: [
            {
              type: "text",
              text: "Documentation not found or not finalized for this library. This might have happened because you used an invalid Context7-compatible library ID. To get a valid Context7-compatible library ID, use the 'resolve-library-id' with the package name you wish to retrieve documentation for.",
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: fetchDocsResponse,
          },
        ],
      };
    }
  );

  // Add session validation middleware
  const originalConnect = server.connect.bind(server);
  server.connect = function(transport: any) {
    // Add periodic check for incomplete tool call sequences
    const checkInterval = setInterval(() => {
      if (sessionState.resolveLibraryIdCalled && !sessionState.getLibraryDocsCalled) {
        const timeSinceResolve = Date.now() - (sessionState.lastResolveLibraryIdTime || 0);
        // If more than 60 seconds have passed since resolve-library-id was called
        if (timeSinceResolve > 75000) {
          console.error(`[WARNING] Session ${sessionIdentifier}: resolve-library-id called but get-library-docs not called within timeout`);
          // Reset session state
          sessionState.resolveLibraryIdCalled = false;
          sessionState.getLibraryDocsCalled = false;
        }
      }
    }, 30000); // Check every 30 seconds
    
    // Clean up interval when connection closes
    transport.onclose = () => {
      clearInterval(checkInterval);
      // Clean up session state
      sessionStates.delete(sessionIdentifier);
    };
    
    return originalConnect(transport);
  };

  return server;
}

async function main() {
  const transportType = TRANSPORT_TYPE;

  if (transportType === "http" || transportType === "sse") {
    // Get initial port from environment or use default
    const initialPort = CLI_PORT ?? 3000;
    // Keep track of which port we end up using
    let actualPort = initialPort;
    const httpServer = createServer(async (req, res) => {
      const url = new URL(req.url || "", `http://${req.headers.host}`).pathname;

      // Set CORS headers for all responses
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS,DELETE");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, MCP-Session-Id, mcp-session-id, MCP-Protocol-Version"
      );
      res.setHeader("Access-Control-Expose-Headers", "MCP-Session-Id");

      // Handle preflight OPTIONS requests
      if (req.method === "OPTIONS") {
        res.writeHead(200);
        res.end();
        return;
      }

      try {
        // Extract client IP address using socket remote address (most reliable)
        const clientIp = getClientIp(req);

        // Create new server instance for each request
        const requestServer = createServerInstance(clientIp);

        if (url === "/mcp") {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
          });
          await requestServer.connect(transport);
          await transport.handleRequest(req, res);
        } else if (url === "/sse" && req.method === "GET") {
          // Create new SSE transport for GET request
          const sseTransport = new SSEServerTransport("/messages", res);
          // Store the transport by session ID
          sseTransports[sseTransport.sessionId] = sseTransport;
          // Clean up transport when connection closes
          res.on("close", () => {
            delete sseTransports[sseTransport.sessionId];
          });
          await requestServer.connect(sseTransport);
        } else if (url === "/messages" && req.method === "POST") {
          // Get session ID from query parameters
          const sessionId =
            new URL(req.url || "", `http://${req.headers.host}`).searchParams.get("sessionId") ??
            "";

          if (!sessionId) {
            res.writeHead(400);
            res.end("Missing sessionId parameter");
            return;
          }

          // Get existing transport for this session
          const sseTransport = sseTransports[sessionId];
          if (!sseTransport) {
            res.writeHead(400);
            res.end(`No transport found for sessionId: ${sessionId}`);
            return;
          }

          // Handle the POST message with the existing transport
          await sseTransport.handlePostMessage(req, res);
        } else if (url === "/ping") {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("pong");
        } else {
          res.writeHead(404);
          res.end("Not found");
        }
      } catch (error) {
        console.error("Error handling request:", error);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end("Internal Server Error");
        }
      }
    });

    // Function to attempt server listen with port fallback
    const startServer = (port: number, maxAttempts = 10) => {
      httpServer.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && port < initialPort + maxAttempts) {
          console.warn(`Port ${port} is in use, trying port ${port + 1}...`);
          startServer(port + 1, maxAttempts);
        } else {
          console.error(`Failed to start server: ${err.message}`);
          process.exit(1);
        }
      });

      httpServer.listen(port, () => {
        actualPort = port;
        console.error(
          `Context7 Documentation MCP Server running on ${transportType.toUpperCase()} at http://localhost:${actualPort}/mcp and legacy SSE at /sse`
        );
      });
    };

    // Start the server with initial port
    startServer(initialPort);
  } else {
    // Stdio transport - this is already stateless by nature
    const server = createServerInstance();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Context7 Documentation MCP Server running on stdio");
  }
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
