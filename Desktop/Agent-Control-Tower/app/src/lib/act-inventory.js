function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function providerAccountRows(providerAccounts) {
  return providerAccounts?.aiAgentProviderAccounts
    ?? providerAccounts?.providerAccounts
    ?? (Array.isArray(providerAccounts) ? providerAccounts : []);
}

function invocationRows(invocations) {
  if (Array.isArray(invocations)) return invocations;
  if (invocations?.aiAgentInvocations) return invocations.aiAgentInvocations;
  if (invocations?.items) return invocations.items;
  return invocations?.aiAgentListing ? [invocations] : [];
}

function addMetrics(target, row) {
  target.totalInvocations += number(row.totalInvocations);
  target.totalSessions += number(row.totalSessions);
  target.inputTokens += number(row.totalInputTokens);
  target.outputTokens += number(row.totalOutputTokens);
}

/**
 * Shape the synchronized ACT snapshot into display-safe agent-building data.
 * Internal IDs are used only for joining/grouping and never leave this module.
 */
export function actInventory(snapshot, externalAccountId = process.env.ACT_INVENTORY_EXTERNAL_ACCOUNT_ID ?? 'solutionsteam-70I6P5') {
  if (!snapshot) return null;
  const allAccounts = providerAccountRows(snapshot.providerAccounts);
  const accounts = allAccounts.filter((account) => account.externalProviderAccountId === externalAccountId);
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const providerAccounts = accounts.map((account) => ({
    name: account.providerAccountName ?? 'Unnamed provider account',
    providerType: account.providerType ?? 'Unknown',
    providerSubType: account.providerSubType ?? null,
    agentCount: number(account.numberOfAgents),
  }));
  const grouped = new Map();
  let unattributed = { totalInvocations: 0, totalSessions: 0, inputTokens: 0, outputTokens: 0 };

  for (const row of invocationRows(snapshot.invocations)) {
    const listing = row?.aiAgentListing ?? {};
    const account = accountById.get(listing.providerAccountGuId);
    if (!account) continue;
    const name = listing.versionName ?? listing.aliasName ?? null;
    if (!name && !listing.agentId && !listing.aliasId) {
      addMetrics(unattributed, row);
      continue;
    }
    const key = listing.agentId ?? listing.aliasId ?? `${listing.providerAccountGuId ?? 'unknown'}:${name ?? 'unnamed'}:${listing.aliasName ?? ''}`;
    let agent = grouped.get(key);
    if (!agent) {
      agent = {
        name: name ?? 'Unnamed agent',
        providerType: listing.providerType ?? account?.providerType ?? 'Unknown',
        providerAccountName: listing.providerAccountName ?? account?.providerAccountName ?? 'Unknown account',
        version: listing.versionName ?? null,
        alias: listing.aliasName ?? null,
        agentStatus: listing.agentStatus ?? 'UNKNOWN',
        aliasStatus: listing.aliasStatus ?? 'UNKNOWN',
        totalInvocations: 0,
        totalSessions: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      grouped.set(key, agent);
    }
    addMetrics(agent, row);
  }

  return {
    providerAccounts,
    agents: [...grouped.values()],
    observedAgentCount: grouped.size,
    totalProviderAgents: providerAccounts.reduce((total, account) => total + account.agentCount, 0),
    unattributedInvocations: unattributed,
  };
}
