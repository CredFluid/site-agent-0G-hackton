import http from "node:http";
import { signMessage, signTypedData, sendTransaction } from "./wallet.js";
import { debug } from "../utils/log.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type SigningRelay = {
  port: number;
  close: () => Promise<void>;
};

/* ------------------------------------------------------------------ */
/*  Request parsing helpers                                            */
/* ------------------------------------------------------------------ */

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function jsonResponse(
  res: http.ServerResponse,
  statusCode: number,
  body: Record<string, unknown>
): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(payload);
}

/* ------------------------------------------------------------------ */
/*  Route handlers                                                     */
/* ------------------------------------------------------------------ */

async function handleSignMessage(body: Record<string, unknown>): Promise<string> {
  const message = body.message as string;
  if (typeof message !== "string") {
    throw new Error("Missing or invalid 'message' field.");
  }

  debug("signing relay: sign-message request");
  return signMessage(message);
}

async function handleSignTypedData(body: Record<string, unknown>): Promise<string> {
  const data = body.data as {
    domain?: Record<string, unknown>;
    types?: Record<string, Array<{ name: string; type: string }>>;
    message?: Record<string, unknown>;
    primaryType?: string;
  };
  if (!data || typeof data !== "object") {
    throw new Error("Missing or invalid 'data' field.");
  }

  debug("signing relay: sign-typed-data request");

  // EIP-712 typed data comes in { domain, types, message, primaryType }
  const domain = data.domain ?? {};
  const types = { ...data.types };
  // Remove EIP712Domain from types — ethers adds it automatically
  delete (types as Record<string, unknown>)["EIP712Domain"];
  const value = data.message ?? {};

  return signTypedData(
    domain,
    types as Record<string, Array<{ name: string; type: string }>>,
    value
  );
}

async function handleSendTransaction(body: Record<string, unknown>): Promise<string> {
  const tx = body.tx as Record<string, unknown>;
  if (!tx || typeof tx !== "object") {
    throw new Error("Missing or invalid 'tx' field.");
  }

  debug("signing relay: send-transaction request", { to: tx.to, value: tx.value });
  return sendTransaction(tx);
}

/* ------------------------------------------------------------------ */
/*  Server                                                             */
/* ------------------------------------------------------------------ */

export function startSigningRelay(): Promise<SigningRelay> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      // CORS preflight
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        });
        res.end();
        return;
      }

      if (req.method !== "POST") {
        jsonResponse(res, 405, { error: "Method not allowed" });
        return;
      }

      try {
        const rawBody = await readBody(req);
        const body = JSON.parse(rawBody) as Record<string, unknown>;
        let result: string;

        switch (req.url) {
          case "/sign-message":
            result = await handleSignMessage(body);
            break;
          case "/sign-typed-data":
            result = await handleSignTypedData(body);
            break;
          case "/send-transaction":
            result = await handleSendTransaction(body);
            break;
          default:
            jsonResponse(res, 404, { error: `Unknown endpoint: ${req.url}` });
            return;
        }

        jsonResponse(res, 200, { result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debug("signing relay: request error", { url: req.url, error: message });
        jsonResponse(res, 500, { error: message });
      }
    });

    // Bind to a random available port on localhost only
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Failed to resolve signing relay address."));
        return;
      }

      const port = addr.port;
      debug("signing relay: started on 127.0.0.1:" + port);

      resolve({
        port,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => {
              debug("signing relay: stopped");
              resolveClose();
            });
          })
      });
    });

    server.on("error", (error) => {
      reject(new Error(`Signing relay failed to start: ${error.message}`));
    });
  });
}
