interface Args {
  all: boolean;
  yes: boolean;
  connectionIds: string[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.yes) {
    throw new Error('Refusing to backfill without --yes. This command resets Plaid cursors for the selected connections.');
  }
  if (!args.all && args.connectionIds.length === 0) {
    throw new Error('Pass --all or one or more --connection=<uuid> values.');
  }

  const [{ and, isNotNull, ne }, dbClient, { connections }, { PLAID_TRANSACTION_HISTORY_DAYS, syncPlaidConnection }] = await Promise.all([
    import('drizzle-orm'),
    import('../db/client.js'),
    import('../db/schema.js'),
    import('../services/plaid.js'),
  ]);

  try {
    const rows = await dbClient.db.query.connections.findMany({
      where: and(
        ne(connections.kind, 'gmail'),
        ne(connections.status, 'disconnected'),
        isNotNull(connections.encryptedAccessToken),
      ),
    });
    const selected = args.all ? rows : rows.filter((row) => args.connectionIds.includes(row.id));
    if (selected.length === 0) {
      console.log('No active Plaid connections matched.');
      return;
    }

    for (const connection of selected) {
      console.log(`Backfilling ${connection.label} (${connection.id}) for ${PLAID_TRANSACTION_HISTORY_DAYS} days...`);
      const added = await syncPlaidConnection(connection.id, {
        resetCursor: true,
        daysRequested: PLAID_TRANSACTION_HISTORY_DAYS,
        skipExistingCategorization: true,
        allowAiCategorization: false,
      });
      console.log(`Finished ${connection.label}: ${added} new transactions added.`);
    }
  } finally {
    await dbClient.closeDb();
  }
}

function parseArgs(argv: string[]): Args {
  const args: Args = { all: false, yes: false, connectionIds: [] };
  for (const arg of argv) {
    if (arg === '--all') args.all = true;
    else if (arg === '--yes') args.yes = true;
    else if (arg.startsWith('--connection=')) args.connectionIds.push(arg.slice('--connection='.length));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
