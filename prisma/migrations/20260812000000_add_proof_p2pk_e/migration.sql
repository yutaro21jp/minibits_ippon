-- NUT-28 P2BK ephemeral pubkey "E", carried on proofs since cashu-ts v4.
-- Nullable: proofs created before this column, and all non-P2BK proofs, have no value.
ALTER TABLE "Proof" ADD COLUMN "p2pkE" TEXT;
