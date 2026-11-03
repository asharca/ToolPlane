-- Old platform approval waits cannot resume as native extension UI requests.
-- Retain their archived decisions and require an explicit new user input.
UPDATE "WorkSession"
SET "status" = 'failed', "uiLease" = NULL
WHERE "status" = 'waiting_approval';
