// Generated from src/client by `npm run build` (scripts/build-client.mjs). Do not edit by hand.
window.__ModuleLoader__.load({
  id: '@automagik/genie-dsh',
  factory: (require) => {
const module = { exports: {} }
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.js
var index_exports = {};
__export(index_exports, {
  GenieWishes: () => GenieWishes,
  apply: () => apply
});
module.exports = __toCommonJS(index_exports);

// src/client/core.js
var import_client = require("@automagik/bots-dsh/client");
var { botChildren, chatSuggestions } = import_client.omni;

// src/client/suggestions.js
var GENIE_SUGGESTIONS = Object.freeze({
  id: "genie",
  order: -10,
  when: ({ bot }) => bot?.kind === "genie",
  items: () => [
    { id: "wish", label: "Make a wish", text: "I wish ", icon: "SparkIcon" },
    { id: "fix", label: "Find what to fix", text: "What should I fix first in this project? ", icon: "SearchIcon" },
    { id: "idea", label: "Think through an idea", text: "Help me think through an idea: ", icon: "MessageIcon" }
  ]
});
function registerSuggestions(chatSuggestions2) {
  return chatSuggestions2?.register ? chatSuggestions2.register(GENIE_SUGGESTIONS) : () => {
  };
}

// src/client/wishes.js
var ENDED_SHOWN = 3;
function endedWishesOf(roster, botId) {
  const tasks = roster?.tasks ?? {};
  return (roster?.genie?.wishes ?? []).filter((wish) => wish.botId === botId).map((wish) => ({
    ...wish,
    status: tasks[wish.sessionId]?.status ?? "ended",
    summary: tasks[wish.sessionId]?.summary
  })).filter((wish) => wish.state === void 0 ? wish.status !== "working" : wish.state !== "working").slice(0, ENDED_SHOWN);
}
var STATE_WORDS = {
  "local-only": { short: "Local branch", full: "Local branch, not published" },
  "no-change": { short: "No change", full: "No change: no branch moved" },
  stopped: { short: "Stopped", full: "Stopped" },
  lost: { short: "Lost", full: "Lost: the team no longer has its record" }
};
var markOf = (outcome) => outcome.state === "done" ? "✓" : outcome.state === "local-only" || outcome.state === "no-change" ? "•" : "✕";
function outcomeOf(wish) {
  const state = wish.state ?? wish.status;
  if (state === "failed") {
    const reason = String(wish.summary ?? "").split("\n")[0].trim();
    return { state: "failed", short: "Failed", full: reason ? `Failed: ${reason}` : "Failed" };
  }
  if (wish.state !== void 0) {
    const words = STATE_WORDS[wish.state] ?? { short: "Ended", full: "Ended" };
    return { state: wish.state, ...words };
  }
  if (state === "stopped") return { state: "stopped", short: "Stopped", full: "Stopped" };
  return { state: "done", short: "Done", full: "Done" };
}

// src/client/index.js
var import_react = require("react");
function GenieWishes({ bot, roster, actions }) {
  if (bot?.kind !== "genie") return null;
  const wishes = endedWishesOf(roster, bot.id);
  if (wishes.length === 0) return null;
  return (0, import_react.createElement)(
    "div",
    { className: "bt-threads", role: "group", "aria-label": `Wishes ${bot.name} granted` },
    wishes.map((wish) => {
      const outcome = outcomeOf(wish);
      return (0, import_react.createElement)(
        "button",
        {
          key: wish.sessionId,
          type: "button",
          className: "bt-thread",
          "data-state": outcome.state,
          "aria-label": `${wish.title}, ${outcome.full}`,
          title: `${wish.title} · ${outcome.full} · ${wish.branch}`,
          onClick: () => actions.openSession(wish.sessionId)
        },
        (0, import_react.createElement)("span", { className: "bt-thread-age", "aria-hidden": true }, markOf(outcome)),
        (0, import_react.createElement)("span", { className: "bt-thread-title" }, wish.title),
        (0, import_react.createElement)("span", { className: "bt-thread-age" }, outcome.short)
      );
    })
  );
}
function apply(ctx) {
  ctx.effect(() => botChildren.register({ id: "genie-wishes", Component: GenieWishes }), "genie: ended wishes");
  ctx.effect(() => registerSuggestions(chatSuggestions), "genie: empty-chat suggestions");
}
return Object.defineProperty({ ...module.exports }, Symbol.toStringTag, { value: 'Module' })
  },
})
