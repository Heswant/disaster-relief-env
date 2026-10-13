import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actInventory } from '../src/lib/act-inventory.js';

test('ACT inventory is limited to the configured solutionsteam account', () => {
  const inventory = actInventory({
    providerAccounts: {
      aiAgentProviderAccounts: [
        { id: 'target-id', externalProviderAccountId: 'solutionsteam-70I6P5', providerAccountName: 'SteamBock', providerType: 'BOOMI', numberOfAgents: 235 },
        { id: 'other-id', externalProviderAccountId: 'microsoft-copilot', providerAccountName: 'Microsoft Copilot Studio', providerType: 'CUSTOM', numberOfAgents: 14 },
      ],
    },
    invocations: [
      { totalInvocations: 3, totalSessions: 2, totalInputTokens: 10, totalOutputTokens: 5, aiAgentListing: { agentId: 'agent-1', providerAccountGuId: 'target-id', providerAccountName: 'SteamBock', providerType: 'BOOMI', versionName: 'Claims Agent', aliasName: 'Claims', agentStatus: 'ACTIVE', aliasStatus: 'ACTIVE' } },
      { totalInvocations: 9, totalSessions: 8, aiAgentListing: { agentId: 'agent-2', providerAccountGuId: 'other-id', providerAccountName: 'Microsoft Copilot Studio', providerType: 'CUSTOM', versionName: 'Other Agent' } },
    ],
  });

  assert.equal(inventory.providerAccounts.length, 1);
  assert.equal(inventory.providerAccounts[0].name, 'SteamBock');
  assert.equal(inventory.totalProviderAgents, 235);
  assert.equal(inventory.observedAgentCount, 1);
  assert.equal(inventory.agents[0].name, 'Claims Agent');
  assert.equal(inventory.agents[0].totalInvocations, 3);
  assert.equal(JSON.stringify(inventory).includes('agent-1'), false);
  assert.equal(JSON.stringify(inventory).includes('target-id'), false);
  assert.equal(JSON.stringify(inventory).includes('solutionsteam-70I6P5'), false);
});
