/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// miniapps/sdk/src/selection-hit-test.ts
var defaultCandidateSelector = "[data-tb-select], tr, li, blockquote, figure, p, h1, h2, h3, h4, h5, h6";
var maxTextLength = 5000;
var toRect = (bounds) => ({
  x: bounds.x,
  y: bounds.y,
  width: bounds.width,
  height: bounds.height
});
var labelFor = (element, index) => {
  const explicit = element.getAttribute("data-tb-label");
  if (explicit) {
    return explicit;
  }
  const firstCell = element.querySelector("td, th")?.textContent?.trim();
  if (firstCell) {
    return firstCell;
  }
  const text = element.textContent?.trim() ?? "";
  return text.length > 0 ? `${text.slice(0, 40)}${text.length > 40 ? "…" : ""}` : `Item ${index + 1}`;
};
var describeTableRow = (row) => {
  const cells = Array.from(row.querySelectorAll("td"));
  if (cells.length === 0) {
    return null;
  }
  const table = row.closest("table");
  const headers = Array.from(table?.querySelectorAll("thead th") ?? []).map((th) => th.textContent?.trim() ?? "");
  if (headers.length !== cells.length) {
    return cells.map((cell) => cell.textContent?.trim() ?? "").join(" | ");
  }
  return cells.map((cell, index) => `${headers[index]}: ${cell.textContent?.trim() ?? ""}`).join(", ");
};
var elementAtPoint = (point, selector = defaultCandidateSelector) => {
  const hit = document.elementFromPoint(point.x, point.y);
  const element = hit?.closest(selector) ?? hit;
  if (!element || element === document.body || element === document.documentElement) {
    return null;
  }
  const text = describeTableRow(element) ?? element.textContent?.trim() ?? "";
  if (text.length === 0) {
    return null;
  }
  const rect = toRect(element.getBoundingClientRect());
  return {
    id: `${labelFor(element, 0)}@${Math.round(rect.x)},${Math.round(rect.y)}`,
    label: labelFor(element, 0),
    text: text.slice(0, maxTextLength),
    rect
  };
};

// miniapps/sdk/src/model-context.ts
var maxToolNameLength = 60;
var maxToolSchemaChars = 8192;
var toolNamePattern = /^[a-zA-Z0-9_-]+$/;
var flattenToolResult = (result) => ({
  content: result.content.filter((part) => part.type === "text").map((part) => part.text).join(`
`),
  ...result.isError ? { isError: true } : {}
});
var textResult = (text, isError) => ({
  content: [{ type: "text", text }],
  ...isError ? { isError: true } : {}
});
var toDescriptor = ({ name, description, inputSchema, annotations }) => ({
  name,
  description,
  ...inputSchema ? { inputSchema } : {},
  ...annotations ? { annotations } : {}
});
var descriptorSignature = (tool) => {
  try {
    return JSON.stringify(toDescriptor(tool));
  } catch {
    return null;
  }
};
var assertValidTool = (tool) => {
  if (typeof tool.execute !== "function") {
    throw new TypeError(`Tool "${tool.name}" has no execute function.`);
  }
  if (!tool.name || !toolNamePattern.test(tool.name) || tool.name.length > maxToolNameLength) {
    throw new TypeError(`Tool name "${tool.name}" must be 1-${maxToolNameLength} characters of [a-zA-Z0-9_-]. ` + "Thunderbolt prefixes it with `app_` for the model provider, which allows no dots and caps the result at 64.");
  }
  if (!tool.description) {
    throw new TypeError(`Tool "${tool.name}" needs a description — it is what the model reads to decide.`);
  }
  if (tool.inputSchema === undefined) {
    return;
  }
  const serialised = (() => {
    try {
      return JSON.stringify(tool.inputSchema);
    } catch {
      return null;
    }
  })();
  if (serialised === null) {
    throw new TypeError(`Tool "${tool.name}" has an inputSchema that is not JSON-serialisable — a circular reference or a BigInt. ` + "Thunderbolt forwards the schema to a model provider as JSON, so it would be dropped during discovery.");
  }
  if (serialised.length > maxToolSchemaChars) {
    throw new TypeError(`Tool "${tool.name}" has an inputSchema of ${serialised.length} characters, over the ` + `${maxToolSchemaChars}-character limit. It rides every request this tool is offered in.`);
  }
};
var shimBrand = Symbol.for("thunderbolt.miniapp.modelContextShim");
var isShim = (candidate) => (shimBrand in candidate);
var createModelContextShim = () => {
  const tools = new Map;
  const listeners = new Set;
  const emit = () => {
    for (const listener of [...listeners]) {
      listener();
    }
  };
  return {
    [shimBrand]: true,
    registerTool: async (tool, options) => {
      assertValidTool(tool);
      if (options?.signal?.aborted) {
        return;
      }
      tools.set(tool.name, tool);
      options?.signal?.addEventListener("abort", () => {
        if (tools.get(tool.name) === tool) {
          tools.delete(tool.name);
          emit();
        }
      });
      emit();
    },
    getTools: async () => [...tools.values()],
    executeTool: async (tool, args) => {
      const name = typeof tool === "string" ? tool : tool.name;
      const registered = tools.get(name);
      if (!registered) {
        return textResult(`No tool named "${name}" is registered.`, true);
      }
      try {
        return await registered.execute(args);
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error), true);
      }
    },
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    }
  };
};
var nativeModelContext = () => {
  if (typeof document === "undefined") {
    return null;
  }
  const candidate = document.modelContext;
  if (!candidate || isShim(candidate) || typeof candidate.registerTool !== "function" || typeof candidate.getTools !== "function" || typeof candidate.executeTool !== "function") {
    return null;
  }
  return candidate;
};
var installed = null;
var installModelContext = () => {
  if (typeof document === "undefined") {
    return { modelContext: createModelContextShim(), native: false };
  }
  const native = nativeModelContext();
  if (native) {
    return { modelContext: native, native: true };
  }
  const existing = document.modelContext;
  if (existing && isShim(existing)) {
    installed ??= { modelContext: existing, native: false };
    return installed;
  }
  if (!installed) {
    const modelContext = createModelContextShim();
    if (existing) {
      console.warn("[thunderbolt] document.modelContext is already set to something without " + "registerTool/getTools/executeTool, so it has been left alone. Tools registered through it will not " + "reach Thunderbolt — pass them to useThunderbolt/connect instead.");
    } else {
      document.modelContext = modelContext;
    }
    installed = { modelContext, native: false };
  }
  return installed;
};
if (typeof document !== "undefined") {
  installModelContext();
}

// miniapps/sdk/src/tools.ts
var toModelContextTool = ({ execute, ...descriptor }) => ({
  ...descriptor,
  execute: async (args) => textResult(String(await execute(args)))
});

// miniapps/sdk/src/bridge.ts
var protocolMarker = "thunderbolt-miniapp";
var protocolVersion = 3;
var documentIdValue = null;
var documentId = () => documentIdValue ??= crypto.randomUUID();
var requestTimeoutMs = 1e4;
var downloadRequestTimeoutMs = 150000;
var selectionDebounceMs = 180;
var readSelection = () => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }
  const text = selection.toString().trim();
  if (text.length === 0) {
    return null;
  }
  const bounds = selection.getRangeAt(0).getBoundingClientRect();
  const rect = bounds.width > 0 || bounds.height > 0 ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : undefined;
  return { text, rect };
};
class NotEmbeddedError extends Error {
  constructor() {
    super("not embedded: window.parent === window");
    this.name = "NotEmbeddedError";
  }
}
var isEmbedded = () => typeof window !== "undefined" && window.parent !== window;
var toBase64 = (contents) => {
  const bytes = contents instanceof Uint8Array ? contents : new Uint8Array(contents);
  const chunk = 32768;
  const parts = Array.from({ length: Math.ceil(bytes.length / chunk) }, (_, index) => String.fromCharCode(...bytes.subarray(index * chunk, (index + 1) * chunk)));
  return btoa(parts.join(""));
};
var toEmbeddedResource = ({ name, contents, mimeType }) => ({
  type: "resource",
  resource: {
    uri: `file:///${encodeURIComponent(name)}`,
    ...mimeType ? { mimeType } : {},
    ...typeof contents === "string" ? { text: contents } : { blob: toBase64(contents) }
  }
});
var connect = (options, timeoutMs = 5000) => {
  const {
    appName,
    hostOrigin = "http://localhost:1420",
    onHostContextChange,
    watchSelection = true,
    resolveElementAt = (point) => elementAtPoint(point),
    getContext,
    tools = [],
    auth = false
  } = options;
  const resolveTools = () => typeof tools === "function" ? tools() : tools;
  const { modelContext } = installModelContext();
  return new Promise((resolve, reject) => {
    if (!isEmbedded()) {
      reject(new NotEmbeddedError);
      return;
    }
    let nextId = 1;
    const pending = new Map;
    const settlePending = (id, result) => {
      const entry = pending.get(id);
      if (!entry) {
        return;
      }
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.settle(result);
    };
    const post = (payload) => {
      window.parent.postMessage({ jsonrpc: "2.0", protocol: protocolMarker, ...payload }, hostOrigin);
    };
    const request = (method, params, deadlineMs = requestTimeoutMs) => {
      const id = nextId++;
      return new Promise((resolveRequest) => {
        const timer2 = setTimeout(() => settlePending(id, { error: { message: `Thunderbolt did not answer ${method} within ${deadlineMs}ms` } }), deadlineMs);
        pending.set(id, { settle: resolveRequest, timer: timer2 });
        post({ id, method, params });
      });
    };
    const notify = (method, params) => post({ method, params });
    let connected = false;
    let mirroring = false;
    let announcementPending = false;
    const announceToolChange = () => {
      if (mirroring) {
        return;
      }
      if (!connected) {
        announcementPending = true;
        return;
      }
      notify("ui/notifications/tools-changed", {});
    };
    modelContext.addEventListener("toolchange", announceToolChange);
    const mirrored = new Map;
    const mirroredTool = (snapshot) => ({
      ...toDescriptor(toModelContextTool(snapshot)),
      execute: async (args) => {
        const current = resolveTools().find((candidate) => candidate.name === snapshot.name);
        if (!current) {
          return textResult(`No tool named "${snapshot.name}" is registered.`, true);
        }
        try {
          return await toModelContextTool(current).execute(args);
        } catch (error) {
          return textResult(error instanceof Error ? error.message : String(error), true);
        }
      }
    });
    const syncOptionTools = async ({ announce }) => {
      mirroring = !announce;
      try {
        await mirrorOptionTools();
      } finally {
        mirroring = false;
      }
    };
    const mirrorOptionTools = async () => {
      const current = resolveTools();
      for (const tool of current) {
        const descriptor = descriptorSignature(tool) ?? `<unserialisable:${tool.name}>`;
        const previous = mirrored.get(tool.name);
        if (previous?.descriptor === descriptor) {
          continue;
        }
        previous?.controller.abort();
        const controller = new AbortController;
        try {
          await modelContext.registerTool(mirroredTool(tool), { signal: controller.signal });
          mirrored.set(tool.name, { descriptor, controller });
        } catch (error) {
          mirrored.delete(tool.name);
          reportError(`tool "${tool.name}" was rejected: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const names = new Set(current.map((tool) => tool.name));
      for (const [name, entry] of [...mirrored]) {
        if (!names.has(name)) {
          entry.controller.abort();
          mirrored.delete(name);
        }
      }
    };
    const answerToolsList = async (requestId) => {
      try {
        await syncOptionTools({ announce: false });
        post({ id: requestId, result: { tools: (await modelContext.getTools()).map(toDescriptor) } });
      } catch (error) {
        reportError(`tools/list failed: ${error instanceof Error ? error.message : String(error)}`);
        post({ id: requestId, result: { tools: [] } });
      }
    };
    const answerToolCall = async (requestId, name, args) => {
      const result = await (async () => {
        try {
          await syncOptionTools({ announce: false });
          const tool = (await modelContext.getTools()).find((candidate) => candidate.name === name);
          return tool ? await modelContext.executeTool(tool, args) : textResult(`No tool named "${name}" is registered.`, true);
        } catch (error) {
          return textResult(error instanceof Error ? error.message : String(error), true);
        }
      })();
      post({ id: requestId, result: flattenToolResult(result) });
    };
    const handleMessage = (event) => {
      if (event.origin !== hostOrigin || event.source !== window.parent) {
        return;
      }
      const data = event.data;
      if (!data || data.protocol !== protocolMarker) {
        return;
      }
      if (typeof data.id === "number" && typeof data.method === "string") {
        if (data.method === "ui/element-at") {
          const point = data.params;
          const element = typeof point?.x === "number" && typeof point?.y === "number" ? resolveElementAt({ x: point.x, y: point.y }) : null;
          post({ id: data.id, result: { element } });
          return;
        }
        if (data.method === "ui/get-context") {
          let context = null;
          try {
            context = getContext?.() ?? null;
          } catch (error) {
            reportError(`getContext threw: ${error instanceof Error ? error.message : String(error)}`);
          }
          post({ id: data.id, result: { context } });
          return;
        }
        if (data.method === "ui/identify") {
          post({ id: data.id, result: { documentId: documentId() } });
          return;
        }
        if (data.method === "tools/list") {
          answerToolsList(data.id);
          return;
        }
        if (data.method === "tools/call") {
          const params = data.params;
          const requestId = data.id;
          answerToolCall(requestId, params?.name ?? "", params?.arguments);
          return;
        }
        return;
      }
      if (typeof data.id === "number") {
        settlePending(data.id, data.error ? { error: data.error } : data.result);
        return;
      }
      if (data.method === "ui/notifications/host-context-changed") {
        onHostContextChange?.(data.params ?? {});
      }
    };
    window.addEventListener("message", handleMessage);
    let teardownSelection = null;
    let teardownErrors = null;
    const disconnect = () => {
      window.removeEventListener("message", handleMessage);
      modelContext.removeEventListener("toolchange", announceToolChange);
      for (const entry of mirrored.values()) {
        entry.controller.abort();
      }
      mirrored.clear();
      teardownSelection?.();
      teardownSelection = null;
      teardownErrors?.();
      teardownErrors = null;
      for (const id of [...pending.keys()]) {
        settlePending(id, { error: { message: "Disconnected from Thunderbolt before the request was answered" } });
      }
    };
    const reportError = (message) => {
      notify("ui/notifications/error", { message: message.slice(0, 500) });
    };
    const startWatchingErrors = () => {
      const onError = (event) => reportError(event.message || "Unknown error");
      const onRejection = (event) => reportError(`Unhandled rejection: ${String(event.reason)}`);
      window.addEventListener("error", onError);
      window.addEventListener("unhandledrejection", onRejection);
      return () => {
        window.removeEventListener("error", onError);
        window.removeEventListener("unhandledrejection", onRejection);
      };
    };
    const startWatchingSelection = () => {
      let timer2;
      let lastSent = null;
      const report = () => {
        const current = readSelection();
        const key = current ? `${current.text}@${current.rect?.x ?? "n"},${current.rect?.y ?? "n"}` : null;
        if (key === lastSent) {
          return;
        }
        lastSent = key;
        notify("ui/notifications/selection-changed", { selection: current });
      };
      const onSelectionChange = () => {
        clearTimeout(timer2);
        timer2 = setTimeout(report, selectionDebounceMs);
      };
      document.addEventListener("selectionchange", onSelectionChange);
      window.addEventListener("scroll", onSelectionChange, {
        passive: true,
        capture: true
      });
      teardownSelection = () => {
        clearTimeout(timer2);
        document.removeEventListener("selectionchange", onSelectionChange);
        window.removeEventListener("scroll", onSelectionChange, {
          capture: true
        });
      };
    };
    const timer = setTimeout(() => {
      disconnect();
      reject(new Error(`Thunderbolt did not respond to initialize within ${timeoutMs}ms`));
    }, timeoutMs);
    const declaredTools = resolveTools().length > 0;
    request("ui/initialize", {
      protocolVersion,
      appName,
      documentId: documentId(),
      capabilities: {
        context: getContext !== undefined,
        selection: watchSelection,
        tools: declaredTools,
        auth
      }
    }, timeoutMs).then((result) => {
      clearTimeout(timer);
      const typed = result;
      if (typed?.error) {
        disconnect();
        reject(new Error(typed.error.message ?? "handshake rejected"));
        return;
      }
      const hostContext = {
        theme: "light",
        locale: "en",
        platform: "web",
        ...typed?.hostContext ?? {}
      };
      onHostContextChange?.(hostContext);
      if (watchSelection) {
        startWatchingSelection();
      }
      teardownErrors = startWatchingErrors();
      connected = true;
      (async () => {
        const hadRegistrations = announcementPending || (await modelContext.getTools()).length > 0;
        announcementPending = false;
        if (!declaredTools && hadRegistrations) {
          announceToolChange();
        }
      })();
      const refreshSkewMs = 30000;
      let currentToken = typed?.auth ?? null;
      const getAuthToken = async () => {
        if (currentToken && Date.parse(currentToken.expiresAt) - Date.now() > refreshSkewMs) {
          return currentToken;
        }
        const next = await request("ui/request-auth-token", {});
        currentToken = next?.token && next?.expiresAt ? { token: next.token, expiresAt: next.expiresAt } : null;
        return currentToken;
      };
      const canDownloadFiles = typed?.capabilities?.downloadFile === true;
      const downloadFile = async (file) => {
        if (!canDownloadFiles) {
          throw new Error("This version of Thunderbolt cannot save files");
        }
        const reply = await request("ui/download-file", { contents: [toEmbeddedResource(file)] }, downloadRequestTimeoutMs);
        if (reply?.error) {
          throw new Error(reply.error.message ?? "Thunderbolt did not save the file");
        }
      };
      resolve({
        getAuthToken,
        canDownloadFiles,
        downloadFile,
        syncTools: () => syncOptionTools({ announce: true }),
        openChat: (prompt) => void request("ui/open-chat", prompt ? { prompt } : {}),
        reportError,
        hostContext,
        disconnect
      });
    });
  });
};

// miniapps/sdk/src/local-entry.ts
var hostOrigin = "__THUNDERBOLT_HOST_ORIGIN__";
var connect2 = (options, timeoutMs) => connect({ ...options, hostOrigin }, timeoutMs);
export {
  textResult,
  isEmbedded,
  connect2 as connect
};
