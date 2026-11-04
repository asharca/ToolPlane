import {
  ensureOmpInstalled,
  installOmpRuntime,
  verifyOmpRuntime,
} from "./omp-install.mjs";

// Keep argv-driven filesystem access out of the server-imported library.
if (process.argv[2] === "verify-runtime")
  process.stdout.write(
    (await verifyOmpRuntime(process.argv[3])) ? "ready" : "missing",
  );
else if (process.argv[2] === "install-runtime")
  await installOmpRuntime(process.argv[3]);
else await ensureOmpInstalled(process.argv[2]);
