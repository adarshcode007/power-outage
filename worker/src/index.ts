import "dotenv/config";

const intervalMs = Number(process.env.WORKER_HEARTBEAT_MS ?? 60_000);

async function main() {
  console.log("worker online");

  const tick = () => {
    console.log(
      JSON.stringify({
        service: "worker",
        alive: true,
        at: new Date().toISOString(),
      }),
    );
  };

  tick();
  setInterval(tick, intervalMs);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
