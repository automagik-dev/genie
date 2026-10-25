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
var { botChildren } = import_client.omni;

// src/client/wishes.js
var ENDED_SHOWN = 3;
function endedWishesOf(roster, botId) {
  const tasks = roster?.tasks ?? {};
  return (roster?.genie?.wishes ?? []).filter((wish) => wish.botId === botId).map((wish) => ({ ...wish, status: tasks[wish.sessionId]?.status ?? "ended" })).filter((wish) => wish.status !== "working").slice(0, ENDED_SHOWN);
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
      const failed = wish.status === "failed";
      const outcome = failed ? "Stopped" : "Done";
      return (0, import_react.createElement)(
        "button",
        {
          key: wish.sessionId,
          type: "button",
          className: "bt-thread",
          "data-state": failed ? "failed" : "done",
          "aria-label": `${wish.title}, ${outcome}`,
          title: `${wish.title} · ${wish.branch}`,
          onClick: () => actions.openSession(wish.sessionId)
        },
        (0, import_react.createElement)("span", { className: "bt-thread-age", "aria-hidden": true }, failed ? "✕" : "✓"),
        (0, import_react.createElement)("span", { className: "bt-thread-title" }, wish.title),
        (0, import_react.createElement)("span", { className: "bt-thread-age" }, outcome)
      );
    })
  );
}
function apply(ctx) {
  ctx.effect(() => botChildren.register({ id: "genie-wishes", Component: GenieWishes }), "genie: ended wishes");
}
return Object.defineProperty({ ...module.exports }, Symbol.toStringTag, { value: 'Module' })
  },
})
