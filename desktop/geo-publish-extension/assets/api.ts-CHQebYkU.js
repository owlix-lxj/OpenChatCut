import { h as htmlToMarkdownNative } from "./jszip.min-DpCewD43.js";
import { c as createLogger } from "./logger-CvfM-6aa.js";
import "./_commonjsHelpers-BosuxZz1.js";

const logger = createLogger("Wechatsync");

const SENSITIVE_API_WHITELIST = [
  "https://www.wechatsync.com",
  "https://developer.wechatsync.com",
  "http://localhost:8080",
];

const MIAOSHE_BRIDGE_API_WHITELIST = [
  "https://miaosheai.com",
  "https://www.miaosheai.com",
  "https://edge.miaosheai.com",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://121.43.106.194",
  "https://121.43.106.194",
];

let currentSyncId = null;
let currentAccounts = [];

function sendToWindow(message) {
  message.callReturn = true;
  window.postMessage(JSON.stringify(message), "*");
}

function sendTaskUpdate(task) {
  window.postMessage(
    JSON.stringify({
      method: "taskUpdate",
      task,
    }),
    "*",
  );
}

function isMiaosheBridgeOrigin(origin) {
  if (MIAOSHE_BRIDGE_API_WHITELIST.includes(origin)) {
    return true;
  }

  try {
    const url = new URL(origin);
    const hostname = url.hostname.toLowerCase();
    return (
      hostname === "miaosheai.com" ||
      hostname.endsWith(".miaosheai.com") ||
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "121.43.106.194"
    );
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message) => {
  try {
    if (message.syncId && currentSyncId && message.syncId !== currentSyncId) {
      return;
    }

    if (message.method === "taskUpdate") {
      sendToWindow({
        task: message.task,
        method: "taskUpdate",
      });
      return;
    }

    if (message.method === "consoleLog") {
      sendToWindow({
        args: message.args,
        method: "consoleLog",
      });
      return;
    }

    if (message.type === "SYNC_PROGRESS") {
      const result = message.result || message.payload?.result;
      if (result) {
        const account = currentAccounts.find((item) => item.type === result.platform);
        if (account) {
          account.status = result.success ? "done" : "failed";
          account.error = result.error;
          account.msg = undefined;
          account.editResp = result.success
            ? { draftLink: result.postUrl || result.url }
            : null;
        }
        sendTaskUpdate({ accounts: currentAccounts });
      }
    }

    if (message.type === "SYNC_DETAIL_PROGRESS") {
      const progress = message.payload || message;
      const account = currentAccounts.find((item) => item.type === progress.platform);
      if (account) {
        account.status = "uploading";
        account.msg =
          progress.stage === "uploading_images"
            ? `上传图片 ${progress.imageProgress?.current}/${progress.imageProgress?.total}`
            : progress.stage === "saving"
              ? "保存中..."
              : progress.stage;
      }
      sendTaskUpdate({ accounts: currentAccounts });
    }

    if (message.type === "SYNC_COMPLETE") {
      currentSyncId = null;
      currentAccounts = [];
    }
  } catch (error) {
    logger.error("Error handling message:", error);
  }
});

function handleGetAccounts(action) {
  chrome.runtime.sendMessage({ type: "CHECK_ALL_AUTH" }, (response) => {
    if (chrome.runtime.lastError) {
      logger.error("getAccounts error:", chrome.runtime.lastError);
      sendToWindow({ eventID: action.eventID, result: [] });
      return;
    }

    const accounts = (response?.platforms || [])
      .filter((platform) => platform.isAuthenticated)
      .map((platform) => ({
        type: platform.id,
        title: platform.username || platform.name,
        displayName: platform.name,
        icon: platform.icon,
        avatar: platform.icon,
        uid: platform.username,
        home: platform.homepage,
        supportTypes: ["html"],
      }));

    sendToWindow({ eventID: action.eventID, result: accounts });
  });
}

function handleAddTask(action) {
  const { task } = action;
  const { post, accounts } = task;
  const platforms = accounts.map((account) => account.type);

  currentSyncId = `sync_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  currentAccounts = accounts.map((account) => ({
    type: account.type,
    title: account.title,
    displayName: account.displayName,
    icon: account.icon,
    avatar: account.avatar,
    uid: account.uid,
    home: account.home,
    supportTypes: account.supportTypes,
    status: "uploading",
    msg: "准备同步...",
    error: undefined,
    editResp: null,
  }));

  sendTaskUpdate({ accounts: currentAccounts });

  const htmlContent = post.content || "";
  const markdown = post.markdown || (htmlContent ? htmlToMarkdownNative(htmlContent) : "");

  chrome.runtime.sendMessage(
    {
      type: "SYNC_ARTICLE",
      payload: {
        article: {
          title: post.title,
          content: htmlContent,
          html: htmlContent,
          markdown,
          cover: post.thumb,
        },
        platforms,
        source: "legacy-api",
        syncId: currentSyncId,
      },
    },
    () => {
      if (chrome.runtime.lastError) {
        logger.error("addTask error:", chrome.runtime.lastError);
      }
    },
  );
}

function handleMagicCall(action) {
  const { methodName, data } = action;
  if (methodName === "uploadImage") {
    chrome.runtime.sendMessage(
      {
        type: "UPLOAD_IMAGE",
        payload: {
          src: data.src,
          platform: data.account?.type || "weibo",
        },
      },
      (response) => {
        if (chrome.runtime.lastError) {
          sendToWindow({
            eventID: action.eventID,
            result: { error: chrome.runtime.lastError.message },
          });
          return;
        }
        sendToWindow({ eventID: action.eventID, result: response });
      },
    );
    return;
  }

  chrome.runtime.sendMessage(
    {
      type: "MAGIC_CALL",
      payload: { methodName, data },
    },
    (response) => {
      if (chrome.runtime.lastError) {
        sendToWindow({
          eventID: action.eventID,
          result: { error: chrome.runtime.lastError.message },
        });
        return;
      }
      sendToWindow({ eventID: action.eventID, result: response });
    },
  );
}

async function handleConfigureBridgeSession(action) {
  const payload = action.payload || {};
  const url = typeof payload.url === "string" ? payload.url.trim() : "";
  let token = typeof payload.token === "string" ? payload.token.trim() : "";

  if (!url) {
    sendToWindow({
      eventID: action.eventID,
      result: { success: false, error: "missing_server_url" },
    });
    return;
  }

  try {
    if (!token) {
      try {
        token = new URL(url).searchParams.get("token")?.trim() || "";
      } catch {
        token = "";
      }
    }

    if (token) {
      await chrome.storage.local.set({ mcpToken: token });
    }

    chrome.runtime.sendMessage(
      {
        type: "MCP_SET_SERVER_URL",
        payload: { url },
      },
      () => {
        if (chrome.runtime.lastError) {
          sendToWindow({
            eventID: action.eventID,
            result: { success: false, error: chrome.runtime.lastError.message },
          });
          return;
        }

        chrome.runtime.sendMessage({ type: "MCP_ENABLE" }, (response) => {
          if (chrome.runtime.lastError) {
            sendToWindow({
              eventID: action.eventID,
              result: { success: false, error: chrome.runtime.lastError.message },
            });
            return;
          }

          sendToWindow({
            eventID: action.eventID,
            result: {
              success: Boolean(response?.success),
              token: token || response?.token,
              serverUrl: url,
            },
          });
        });
      },
    );
  } catch (error) {
    sendToWindow({
      eventID: action.eventID,
      result: {
        success: false,
        error: error instanceof Error ? error.message : "configure_failed",
      },
    });
  }
}

window.addEventListener("message", async (event) => {
  try {
    const action = JSON.parse(event.data);
    if (!action?.method) {
      return;
    }

    if (action.method === "configureBridgeSession") {
      if (!isMiaosheBridgeOrigin(event.origin)) {
        sendToWindow({
          eventID: action.eventID,
          result: { success: false, error: "origin_not_allowed" },
        });
        return;
      }

      await handleConfigureBridgeSession(action);
      return;
    }

    if (action.method === "getAccounts") {
      handleGetAccounts(action);
    }

    if (action.method === "addTask") {
      handleAddTask(action);
    }

    if (action.method === "magicCall") {
      handleMagicCall(action);
    }

    if (SENSITIVE_API_WHITELIST.includes(event.origin)) {
      if (action.method === "updateDriver") {
        logger.warn("updateDriver is deprecated in v2");
        sendToWindow({
          eventID: action.eventID,
          result: { success: true, deprecated: true },
        });
      }

      if (action.method === "startInspect") {
        logger.warn("startInspect is deprecated in v2");
        sendToWindow({
          eventID: action.eventID,
          result: { success: true, deprecated: true },
        });
      }
    }
  } catch {
    // Ignore non-JSON messages.
  }
});

function injectAPI() {
  setTimeout(() => {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("inject-api.js");
    script.onload = () => {
      script.remove();
    };
    (document.head || document.documentElement).appendChild(script);
  }, 50);
}

export function onExecute() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectAPI, { once: true });
  } else {
    injectAPI();
  }
}

onExecute();
