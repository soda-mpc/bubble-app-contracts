"use client";

import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import {
  type AgentRecord,
  createAgent,
  deleteAgent,
  listAgents,
} from "~~/services/agents/agentStore";
import { recordActivity } from "~~/services/activity/activityStore";

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [name, setName] = useState("");
  const [revealId, setRevealId] = useState<string | null>(null);

  const refresh = () => setAgents(listAgents());

  useEffect(() => {
    refresh();
  }, []);

  const onCreate = () => {
    const agent = createAgent(name || `Agent ${agents.length + 1}`);
    recordActivity({
      kind: "agent_create",
      summary: `Created agent “${agent.name}”`,
      address: agent.address,
      agentId: agent.id,
      agentName: agent.name,
    });
    setName("");
    refresh();
    toast.success(`Created ${agent.name}`);
  };

  const onDelete = (id: string) => {
    const agent = agents.find((a) => a.id === id);
    deleteAgent(id);
    recordActivity({
      kind: "agent_delete",
      summary: `Deleted agent “${agent?.name || id}”`,
      address: agent?.address,
      agentId: id,
      agentName: agent?.name,
    });
    refresh();
    toast.success("Agent removed from this browser");
  };

  const copy = async (value: string, label: string) => {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div>
        <h1 className="page-title">Agents</h1>
        <p className="page-subtitle">
          Simulated agent EOAs for the demo. Private keys stay in localStorage — do not use real funds.
        </p>
      </div>

      <div className="panel p-6">
        <h2 className="mb-4 text-lg font-semibold text-[var(--wallet-text-strong)]">New agent</h2>
        <label className="field-label" htmlFor="agent-name">
          Name
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            id="agent-name"
            className="field-input"
            placeholder="Ops agent"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="button" className="btn btn-primary shrink-0" onClick={onCreate}>
            Create agent
          </button>
        </div>
      </div>

      <div className="panel overflow-hidden">
        <div className="border-b border-[var(--wallet-border)] px-6 py-4">
          <h2 className="text-lg font-semibold text-[var(--wallet-text-strong)]">
            Roster ({agents.length})
          </h2>
        </div>
        {agents.length === 0 ? (
          <p className="p-6 text-[var(--wallet-text-muted)]">No agents yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--wallet-border)]">
            {agents.map((agent) => (
              <li key={agent.id} className="flex flex-col gap-3 px-6 py-4 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0">
                  <div className="font-semibold text-[var(--wallet-text-strong)]">{agent.name}</div>
                  <div className="mono text-xs text-[var(--wallet-text-muted)]">{agent.address}</div>
                  {revealId === agent.id && (
                    <div className="mono mt-2 rounded-lg bg-[var(--wallet-warning-soft)] p-2 text-xs text-[var(--wallet-warning)]">
                      {agent.privateKey}
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => copy(agent.address, "Address")}
                  >
                    Copy address
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setRevealId(revealId === agent.id ? null : agent.id)}
                  >
                    {revealId === agent.id ? "Hide key" : "Show key"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm text-[var(--wallet-error)]"
                    onClick={() => onDelete(agent.id)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
