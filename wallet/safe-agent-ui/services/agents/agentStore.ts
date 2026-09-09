import { Wallet } from "ethers";
import { readJson, storageKeys, writeJson } from "../storage/localStore";

export type AgentRecord = {
  id: string;
  name: string;
  address: `0x${string}`;
  privateKey: `0x${string}`;
  createdAt: string;
};

export function listAgents(): AgentRecord[] {
  return readJson<AgentRecord[]>(storageKeys.agents, []);
}

export function saveAgents(agents: AgentRecord[]) {
  writeJson(storageKeys.agents, agents);
}

export function createAgent(name: string): AgentRecord {
  const wallet = Wallet.createRandom();
  const agent: AgentRecord = {
    id: crypto.randomUUID(),
    name: name.trim() || "Agent",
    address: wallet.address as `0x${string}`,
    privateKey: wallet.privateKey as `0x${string}`,
    createdAt: new Date().toISOString(),
  };
  const next = [agent, ...listAgents()];
  saveAgents(next);
  return agent;
}

export function deleteAgent(id: string) {
  saveAgents(listAgents().filter((a) => a.id !== id));
}

export function getAgent(id: string): AgentRecord | undefined {
  return listAgents().find((a) => a.id === id);
}
