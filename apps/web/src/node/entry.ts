import { needsInstallationGuide, startInstallationGuide } from "./installer";
import {
  startNodeRuntime,
  formatNodeStartupError,
  NodeStartupError,
} from "./runtime";
startNodeRuntime()
  .then((runtime) => {
    console.log(`Open Whiteboard is listening on port ${runtime.port}.`);
    let stopping = false;
    const stop = (failed = false) => {
      if (stopping) return;
      stopping = true;
      const forced = setTimeout(() => process.exit(1), 15_000);
      forced.unref();
      // Keep the unref'ed deadline armed: abandoned background I/O must not
      // keep this process (and a provider rollout) alive beyond the grace period.
      runtime.close().then(
        () => {
          process.exitCode = failed ? 1 : 0;
        },
        () => {
          process.exitCode = 1;
        },
      );
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.on(signal, () => stop());
    void runtime.failure.then(() => {
      console.error("Database ownership was lost. Restarting is required.");
      stop(true);
    });
  })
  .catch(async (error) => {
    console.error(formatNodeStartupError(error));
    if (error instanceof NodeStartupError && needsInstallationGuide(error)) {
      try {
        const guide = await startInstallationGuide(error);
        console.log(`Installation guide is listening on port ${guide.port}.`);
        let stopping = false;
        for (const signal of ["SIGINT", "SIGTERM"] as const)
          process.on(signal, () => {
            if (stopping) return;
            stopping = true;
            guide.close().then(
              () => {
                process.exitCode = 0;
              },
              () => {
                process.exitCode = 1;
              },
            );
          });
        return;
      } catch {
        console.error(
          "Installation guide could not start. Check the assigned PORT and hosting settings.",
        );
      }
    }
    process.exitCode = 1;
  });
