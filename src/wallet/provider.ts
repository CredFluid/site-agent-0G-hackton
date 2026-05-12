import type { WalletConfig } from "./wallet.js";

/**
 * Builds a JavaScript source string that, when evaluated in a browser page via
 * `context.addInitScript()`, installs a minimal EIP-1193-compatible
 * `window.ethereum` provider backed by the agent's server-side signing relay.
 *
 * The injected provider:
 *  - Auto-connects (returns the agent address for `eth_requestAccounts`)
 *  - Proxies read-only RPC calls to the configured JSON-RPC endpoint
 *  - Delegates signing operations to the local signing relay running on `relayPort`
 *  - Emits EIP-1193 events (`connect`, `accountsChanged`, `chainChanged`)
 *  - Reports `isMetaMask = true` for dApp compatibility
 */
export function buildWeb3InjectionScript(args: {
  walletConfig: WalletConfig;
  relayPort: number;
}): string {
  const { walletConfig, relayPort } = args;
  const address = walletConfig.address.toLowerCase();
  const chainIdHex = `0x${walletConfig.chainId.toString(16)}`;
  const rpcUrl = walletConfig.rpcUrl;
  const relayOrigin = `http://127.0.0.1:${relayPort}`;

  // The entire script is a self-executing IIFE injected before any page JS runs.
  return `(function() {
  "use strict";

  if (window.ethereum && window.ethereum.__agentProbeInjected) {
    return;
  }

  var AGENT_ADDRESS = ${JSON.stringify(address)};
  var CHAIN_ID_HEX = ${JSON.stringify(chainIdHex)};
  var CHAIN_ID_DEC = ${walletConfig.chainId};
  var RPC_URL = ${JSON.stringify(rpcUrl)};
  var RELAY_ORIGIN = ${JSON.stringify(relayOrigin)};
  var connected = true;
  var upstreamEthereum = window.ethereum && !window.ethereum.__siteAgentInjected ? window.ethereum : null;

  /* ----- Event emitter ----- */
  var listeners = {};

  function on(event, fn) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(fn);
  }

  function removeListener(event, fn) {
    if (!listeners[event]) return;
    listeners[event] = listeners[event].filter(function(f) { return f !== fn; });
  }

  function emit(event) {
    var args = Array.prototype.slice.call(arguments, 1);
    (listeners[event] || []).forEach(function(fn) {
      try { fn.apply(null, args); } catch(e) { console.warn("[agentprobe-wallet] listener error:", e); }
    });
  }

  /* ----- JSON-RPC helpers ----- */
  var rpcId = 1;

  function rpcCall(method, params) {
    return fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: method, params: params || [] })
    })
    .then(function(res) { return res.json(); })
    .then(function(json) {
      if (json.error) throw new Error(json.error.message || "RPC error");
      return json.result;
    });
  }

  function relayCall(endpoint, body) {
    return fetch(RELAY_ORIGIN + endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
    .then(function(res) { return res.json(); })
    .then(function(json) {
      if (json.error) throw new Error(json.error);
      return json.result;
    });
  }

  function maybeCaptureUpstreamEthereum(candidate) {
    if (!candidate || candidate === provider || candidate.__agentProbeInjected) {
      return;
    }

    if (
      !upstreamEthereum ||
      candidate.isMetaMask ||
      (candidate._metamask && typeof candidate._metamask.isUnlocked === "function")
    ) {
      upstreamEthereum = candidate;
    }
  }

  function getUpstreamEthereum() {
    if (!upstreamEthereum && window.ethereum && window.ethereum !== provider && !window.ethereum.__agentProbeInjected) {
      maybeCaptureUpstreamEthereum(window.ethereum);
    }

    if (!upstreamEthereum && window.ethereum && Array.isArray(window.ethereum.providers)) {
      var announcedMetaMaskProvider = window.ethereum.providers.find(function(candidate) {
        return candidate && candidate !== provider && (candidate.isMetaMask || candidate._metamask);
      });
      maybeCaptureUpstreamEthereum(announcedMetaMaskProvider);
    }

    return upstreamEthereum && upstreamEthereum !== provider ? upstreamEthereum : null;
  }

  /* ----- EIP-1193 request handler ----- */
  function request(args) {
    var method = args.method;
    var params = args.params || [];
    var originalEthereum = getUpstreamEthereum();

    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        if (originalEthereum && originalEthereum.request) {
           return originalEthereum.request(args);
        }
        return Promise.resolve([AGENT_ADDRESS]);

      case "eth_chainId":
        if (originalEthereum && originalEthereum.request) {
           return originalEthereum.request(args).catch(function() { return CHAIN_ID_HEX; });
        }
        return Promise.resolve(CHAIN_ID_HEX);

      case "net_version":
        if (originalEthereum && originalEthereum.request) {
           return originalEthereum.request(args).catch(function() { return String(CHAIN_ID_DEC); });
        }
        return Promise.resolve(String(CHAIN_ID_DEC));

      case "wallet_switchEthereumChain":
        if (originalEthereum && originalEthereum.request) {
           return originalEthereum.request(args);
        }
        /* Accept any chain switch silently — the relay always uses the configured chain */
        emit("chainChanged", CHAIN_ID_HEX);
        return Promise.resolve(null);

      case "wallet_addEthereumChain":
        if (originalEthereum && originalEthereum.request) {
           return originalEthereum.request(args);
        }
        emit("chainChanged", CHAIN_ID_HEX);
        return Promise.resolve(null);

      case "wallet_requestPermissions":
        if (originalEthereum && originalEthereum.request) {
           return originalEthereum.request(args);
        }
        return Promise.resolve([{ parentCapability: "eth_accounts" }]);

      case "wallet_watchAsset":
        if (originalEthereum && originalEthereum.request) {
           return originalEthereum.request(args);
        }
        return Promise.resolve(true);

      case "eth_sendTransaction":
        if (originalEthereum && originalEthereum.request) {
           return originalEthereum.request(args);
        }
        return relayCall("/send-transaction", { tx: params[0] });

      case "personal_sign":
        if (originalEthereum && originalEthereum.request) {
           return originalEthereum.request(args);
        }
        return relayCall("/sign-message", { message: params[0], address: params[1] });

      case "eth_sign":
        if (originalEthereum && originalEthereum.request) {
           return originalEthereum.request(args);
        }
        return relayCall("/sign-message", { message: params[1], address: params[0] });

      case "eth_signTypedData":
      case "eth_signTypedData_v3":
      case "eth_signTypedData_v4":
        if (originalEthereum && originalEthereum.request) {
           return originalEthereum.request(args);
        }
        var typedDataParam = typeof params[1] === "string" ? JSON.parse(params[1]) : params[1];
        return relayCall("/sign-typed-data", { data: typedDataParam });

      /* Read-only calls — proxy directly to the RPC endpoint */
      case "eth_getBalance":
      case "eth_blockNumber":
      case "eth_call":
      case "eth_estimateGas":
      case "eth_gasPrice":
      case "eth_getTransactionCount":
      case "eth_getTransactionReceipt":
      case "eth_getTransactionByHash":
      case "eth_getCode":
      case "eth_getStorageAt":
      case "eth_getLogs":
      case "eth_getBlockByNumber":
      case "eth_getBlockByHash":
      case "eth_feeHistory":
      case "eth_maxPriorityFeePerGas":
        return rpcCall(method, params);

      default:
        /* Attempt to proxy unknown methods to RPC — some dApps use non-standard calls */
        return rpcCall(method, params);
    }
  }

  /* ----- Legacy send / sendAsync ----- */
  function send(methodOrPayload, callbackOrParams) {
    if (typeof methodOrPayload === "string") {
      return request({ method: methodOrPayload, params: callbackOrParams || [] });
    }
    /* JSON-RPC payload object with callback */
    if (typeof callbackOrParams === "function") {
      request({ method: methodOrPayload.method, params: methodOrPayload.params || [] })
        .then(function(result) { callbackOrParams(null, { id: methodOrPayload.id, jsonrpc: "2.0", result: result }); })
        .catch(function(err) { callbackOrParams(err, null); });
      return;
    }
    return request({ method: methodOrPayload.method, params: methodOrPayload.params || [] });
  }

  function sendAsync(payload, callback) {
    request({ method: payload.method, params: payload.params || [] })
      .then(function(result) { callback(null, { id: payload.id, jsonrpc: "2.0", result: result }); })
      .catch(function(err) { callback(err, null); });
  }

  /* ----- Provider object ----- */
  var provider = {
    isMetaMask: true,
    __agentProbeInjected: true,
    get chainId() {
      var originalEthereum = getUpstreamEthereum();
      return originalEthereum && originalEthereum.chainId ? originalEthereum.chainId : CHAIN_ID_HEX;
    },
    get networkVersion() {
      var originalEthereum = getUpstreamEthereum();
      return originalEthereum && originalEthereum.networkVersion ? originalEthereum.networkVersion : String(CHAIN_ID_DEC);
    },
    get selectedAddress() {
      var originalEthereum = getUpstreamEthereum();
      return originalEthereum && originalEthereum.selectedAddress ? originalEthereum.selectedAddress : AGENT_ADDRESS;
    },
    isConnected: function() {
      var originalEthereum = getUpstreamEthereum();
      return originalEthereum && typeof originalEthereum.isConnected === "function"
        ? originalEthereum.isConnected()
        : connected;
    },
    request: request,
    send: send,
    sendAsync: sendAsync,
    on: on,
    removeListener: removeListener,
    removeAllListeners: function(event) {
      if (event) { listeners[event] = []; }
      else { listeners = {}; }
    },
    /* Some dApps access these */
    enable: function() { return request({ method: "eth_requestAccounts" }); },
    _metamask: {
      isUnlocked: function() {
        var originalEthereum = getUpstreamEthereum();
        if (originalEthereum && originalEthereum._metamask && typeof originalEthereum._metamask.isUnlocked === "function") {
          return originalEthereum._metamask.isUnlocked();
        }
        return Promise.resolve(true);
      }
    }
  };

  try {
    window.addEventListener("eip6963:announceProvider", function(event) {
      var detail = event && event.detail ? event.detail : null;
      if (!detail || detail.provider === provider) {
        return;
      }

      var info = detail.info || {};
      if (info.rdns === "com.siteagent.wallet") {
        return;
      }

      if (info.rdns === "io.metamask" || /metamask/i.test(info.name || "") || detail.provider.isMetaMask) {
        maybeCaptureUpstreamEthereum(detail.provider);
      }
    });
  } catch(e) { /* Provider discovery listener is optional */ }

  /* Announce the provider using EIP-6963 for modern dApps */
  try {
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
      detail: Object.freeze({
        info: {
          uuid: "agentprobe-wallet-00000000",
          name: "AgentProbe Wallet",
          icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
          rdns: "com.agentprobe.wallet"
        },
        provider: provider
      })
    }));
    /* Listen for discovery requests */
    window.addEventListener("eip6963:requestProvider", function() {
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
        detail: Object.freeze({
          info: {
            uuid: "agentprobe-wallet-00000000",
            name: "AgentProbe Wallet",
            icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
            rdns: "com.agentprobe.wallet"
          },
          provider: provider
        })
      }));
    });
  } catch(e) { /* EIP-6963 not critical */ }

  /* Install as window.ethereum */
  Object.defineProperty(window, "ethereum", {
    configurable: true,
    enumerable: true,
    get: function() { return provider; },
    set: function(candidate) { maybeCaptureUpstreamEthereum(candidate); }
  });

  /* Fire initial connect event on next tick */
  setTimeout(function() {
    emit("connect", { chainId: CHAIN_ID_HEX });
    emit("accountsChanged", [AGENT_ADDRESS]);
  }, 0);

  console.log("[agentprobe-wallet] Injected Web3 provider — address:", AGENT_ADDRESS, "chain:", CHAIN_ID_DEC);
})();`;
}
