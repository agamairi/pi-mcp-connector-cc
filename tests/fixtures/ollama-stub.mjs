#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import process from "node:process";

export function createOllamaStub({ port = 0, models = null, numCtx = 8192, version = "0.40.16" } = {}) {
  const modelRows = models ?? [{ name: "bonsai-2:9b", capabilities: ["completion", "vision", "tools", "thinking"] }];
  const server = http.createServer(async (request, response) => {
    const send = (status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    if (request.url === "/api/version") return send(200, { version });
    if (request.url === "/api/tags") return send(200, { models: modelRows });
    if (request.url === "/v1/models") return send(200, { data: modelRows.map((row) => ({ id: row.name, object: "model" })) });
    if (request.url === "/api/ps") return send(200, { models: modelRows.map((row) => ({ name: row.name, context_length: numCtx })) });
    if (request.url === "/api/show") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const name = JSON.parse(body || "{}").name;
      if (!modelRows.some((row) => row.name === name)) return send(404, { error: "model not found" });
      return send(200, { details: { context_length: numCtx }, parameters: `num_ctx ${numCtx}` });
    }
    if (request.url === "/v1/chat/completions") return send(200, { choices: [{ message: { role: "assistant", content: "stub response" } }] });
    return send(404, { error: "not found" });
  });
  return {
    server,
    listen() { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve(server.address().port)); }); },
    close() { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}

if (process.argv[1] && process.argv[1].endsWith("ollama-stub.mjs")) {
  const models = process.env.OLLAMA_STUB_MODELS ? JSON.parse(process.env.OLLAMA_STUB_MODELS) : null;
  const stub = createOllamaStub({ port: Number(process.env.OLLAMA_STUB_PORT || 0), models, numCtx: Number(process.env.OLLAMA_STUB_NUM_CTX || 8192) });
  const port = await stub.listen();
  if (process.env.OLLAMA_STUB_PORT_FILE) fs.writeFileSync(process.env.OLLAMA_STUB_PORT_FILE, String(port));
}
