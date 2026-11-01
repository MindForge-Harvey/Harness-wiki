import React from "react";
import AgentChat from "./components/AgentChat";
import DispatchWorkspace from "./components/DispatchWorkspace";
import { appUrl } from "./lib/app-url";

export default function App() {
  if (window.location.pathname !== appUrl("chat")) {
    window.history.replaceState(null, "", appUrl("chat") + window.location.search);
  }
  return new URLSearchParams(window.location.search).get('workspace') === 'knowledge' ? <AgentChat /> : <DispatchWorkspace />;
}
