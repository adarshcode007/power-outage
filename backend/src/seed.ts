import "dotenv/config";
import { prisma } from "./lib/prisma.js";
import { loadSyntheticNetwork } from "./lib/network-loader.js";

async function main() {
  const summary = await loadSyntheticNetwork();

  console.log(
    JSON.stringify(
      {
        seeded: true,
        seed: summary.seed,
        feeders: summary.feeders,
        transformers: summary.transformers,
        poles: summary.poles,
        devices: summary.devices,
        edges: summary.edges,
        scheduledOutages: summary.scheduledOutages,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
