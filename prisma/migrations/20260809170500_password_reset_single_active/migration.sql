-- Only one reset link may be active for an account. This also makes the
-- request cooldown enforceable with an atomic conditional update.
DROP INDEX "PasswordResetToken_userId_createdAt_idx";
CREATE UNIQUE INDEX "PasswordResetToken_userId_key" ON "PasswordResetToken"("userId");
