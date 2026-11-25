import { catalogHelp, runCatalog } from './fork-catalog.js';
import { inventoryHelp, runEnableModels, runInventory } from './fork-inventory.js';
import { premiumHelp, runPremium } from './fork-premium.js';

// Fork-only commands (local/customizations). index.ts hands the whole argv to
// runForkCommand before its own parser, so these keep their own flags.

const COMMANDS: Record<string, { help: () => string; run: (argv: string[]) => Promise<number> }> = {
  catalog: { help: catalogHelp, run: runCatalog },
  premium: { help: premiumHelp, run: runPremium },
  inventory: { help: inventoryHelp, run: runInventory },
  'enable-models': { help: inventoryHelp, run: runEnableModels },
};

export const FORK_HELP_LINES = [
  '  catalog           Local overlay on the signed catalog: list, add, block, claim, release (catalog --help)',
  '  premium           License and catalog sync state (premium status|sync)',
  '  inventory         Keys and models per platform (inventory --help)',
  '  enable-models     Re-enable the disabled chat models of a platform (inventory --help)',
];

/** The command must come first: these commands do not accept global flags before it. */
export function isForkCommand(command: string | undefined): boolean {
  return command !== undefined && Object.hasOwn(COMMANDS, command);
}

export async function runForkCommand(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const entry = COMMANDS[command];
  if (rest.includes('--help') || rest.includes('-h')) {
    process.stdout.write(`${entry.help()}\n`);
    return 0;
  }
  return entry.run(rest);
}
