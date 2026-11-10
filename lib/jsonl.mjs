import { StringDecoder } from "node:string_decoder";

function assistantText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part) => typeof part === "string" ? part : part?.text ?? "").join("");
  }
  return typeof message.text === "string" ? message.text : "";
}

function errorText(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const message = value.message ?? value.error?.message ?? value.reason;
    if (typeof message === "string" && message) return message;
    try { return JSON.stringify(value).slice(0, 500); } catch { return fallback; }
  }
  return String(value);
}

export function createJsonlState() {
  return {
    session: null,
    finalText: "",
    usage: null,
    errors: [],
    retryErrors: [],
    toolErrors: [],
    toolEvents: [],
    events: [],
    malformed: [],
    agentEnd: false,
    agentEndWillRetry: false,
    lastEventAt: null,
  };
}

export function acceptJsonEvent(state, event) {
  if (!event || typeof event !== "object") return;
  state.events.push(event);
  state.lastEventAt = Date.now();
  if (event.type === "session") state.session = event;
  if (event.type === "message_end" && event.message?.role === "assistant") {
    state.finalText = assistantText(event.message);
  }
  if (event.type === "message_update") {
    if (event.usage) state.usage = event.usage;
    const detail = event.assistantMessageEvent;
    if (detail?.type === "error") state.errors.push(errorText(detail.error ?? detail.message ?? detail.reason, "Provider error"));
  }
  if (event.type === "auto_retry_end" && event.finalError) state.retryErrors.push(errorText(event.finalError, "Provider retry exhausted"));
  if (event.type === "tool_execution_start") state.toolEvents.push(event);
  // Tool errors are recoverable: the model may retry or route around them, so they are reported, not fatal.
  if (event.type === "tool_execution_end" && event.isError) state.toolErrors.push(errorText(event.result, `${event.toolName} failed`));
  if (event.type === "agent_end") {
    state.agentEnd = true;
    state.agentEndWillRetry = Boolean(event.willRetry);
  }
}

export function parseJsonLine(line, state = createJsonlState()) {
  const trimmed = String(line).trim();
  if (!trimmed) return state;
  try {
    acceptJsonEvent(state, JSON.parse(trimmed));
  } catch {
    state.malformed.push(trimmed);
  }
  return state;
}

export function createIncrementalJsonlParser(state = createJsonlState()) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  return {
    state,
    push(chunk) {
      buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) parseJsonLine(line.replace(/\r$/, ""), state);
    },
    end() {
      buffer += decoder.end();
      if (buffer) parseJsonLine(buffer.replace(/\r$/, ""), state);
      return state;
    },
  };
}

export function extractResultClaim(text) {
  const value = String(text ?? "");
  const marker = value.lastIndexOf("## Result");
  if (marker < 0) return null;
  const claim = value.slice(marker).trim();
  return claim.length > 1500 ? `${claim.slice(0, 1500)}…` : claim;
}

export function parserSummary(state) {
  const providerErrors = [...state.errors, ...state.retryErrors];
  return {
    sessionId: state.session?.id ?? null,
    finalText: state.finalText,
    usage: state.usage,
    providerErrors,
    toolEvents: state.toolEvents,
    toolErrors: state.toolErrors,
    malformedLines: state.malformed,
    agentEnd: state.agentEnd,
    modelClaim: extractResultClaim(state.finalText),
  };
}
