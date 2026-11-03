-- OMP native tasks and platform Agent delegation may now be enabled together.
ALTER TABLE "Agent" DROP CONSTRAINT "Agent_nativeSubagentMode_check";
ALTER TABLE "Agent"
  ADD CONSTRAINT "Agent_nativeSubagentMode_check" CHECK ("subagentMode" <> 'native' OR "runtimeKind" = 'omp');
