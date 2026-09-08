/**
 * Pairing / auth state, one of the domain hooks AppContext composes.
 *
 * Manages the pairing code UI (input, submit, error, busy). The startup
 * effect sets pairingEnabled/pairingExpiresAt from the backend — those
 * setters are returned so AppContext can wire them.
 */

import { useCallback, useRef, useState } from "react";
import { client } from "../api";
import { persistActiveServerCredential } from "./active-server-credential";

const PAIRING_PERSISTENCE_ERROR =
  "Pairing succeeded, but this device could not save the connection. Keep this window open and submit again to retry saving.";

export type PairingFailureCode =
  | "PAIRING_INVALID"
  | "PAIRING_EXPIRED"
  | "PAIRING_DISABLED"
  | "PAIRING_NOT_READY"
  | "PAIRING_INSTANCE_MISMATCH"
  | "PAIRING_RATE_LIMITED"
  | "PAIRING_SESSION_FAILED";

/** Converts the server's stable pairing verdict into an actionable UI state. */
export function pairingFailureMessage(error: unknown): string {
  const code = (error as { code?: string }).code as
    | PairingFailureCode
    | undefined;
  switch (code) {
    case "PAIRING_INVALID":
      return "The pairing code is invalid. Check the code and try again.";
    case "PAIRING_EXPIRED":
      return "Pairing code expired. Generate a new code and try again.";
    case "PAIRING_DISABLED":
      return "Pairing is disabled on this server. Ask the server owner to enable it.";
    case "PAIRING_NOT_READY":
      return "The server is still starting. Wait a moment and try the same code again.";
    case "PAIRING_INSTANCE_MISMATCH":
      return "The server instance changed. Refresh the code from the server and try again.";
    case "PAIRING_RATE_LIMITED":
      return "Too many attempts. Try again later.";
    case "PAIRING_SESSION_FAILED":
      return "The code was accepted, but the server could not create a session. Generate a new code and try again.";
    default: {
      const status = (error as { status?: number }).status;
      if (status === 410)
        return "Pairing code expired. Generate a new code and try again.";
      if (status === 429) return "Too many attempts. Try again later.";
      return "Pairing failed. Check the code and try again.";
    }
  }
}

export function usePairingState() {
  const [pairingEnabled, setPairingEnabled] = useState(false);
  const [pairingExpiresAt, setPairingExpiresAt] = useState<number | null>(null);
  const [pairingCodeInput, setPairingCodeInput] = useState("");
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const pairingBusyRef = useRef(false);
  const pendingCredentialRef = useRef<{
    token: string;
    apiBase: string;
  } | null>(null);

  const handlePairingSubmit = useCallback(async () => {
    // The ref is the synchronous submit lock. React state only renders the busy
    // indicator and may still hold the previous request's value for one render.
    if (pairingBusyRef.current) return;
    const pendingCredential = pendingCredentialRef.current;
    const code = pairingCodeInput.trim();
    if (!pendingCredential && !code) {
      setPairingError("Enter the pairing code from your server.");
      return;
    }
    setPairingError(null);
    pairingBusyRef.current = true;
    setPairingBusy(true);
    try {
      let credential = pendingCredential;
      if (!credential) {
        try {
          const { token } = await client.pair(code);
          credential = { token, apiBase: client.getBaseUrl() };
          pendingCredentialRef.current = credential;
        } catch (err) {
          // error-policy:J4 the server's stable pairing verdict becomes distinct
          // recovery guidance while the one-use code has not succeeded.
          setPairingError(pairingFailureMessage(err));
          return;
        }
      }

      try {
        await persistActiveServerCredential(
          credential.token,
          credential.apiBase,
        );
      } catch {
        // error-policy:J4 the server already consumed the one-use code, so keep
        // the issued credential and retry only durable persistence.
        setPairingError(PAIRING_PERSISTENCE_ERROR);
        return;
      }

      client.setToken(credential.token);
      pendingCredentialRef.current = null;
      window.location.reload();
    } finally {
      pairingBusyRef.current = false;
      setPairingBusy(false);
    }
  }, [pairingCodeInput]);

  return {
    state: {
      pairingEnabled,
      pairingExpiresAt,
      pairingCodeInput,
      pairingError,
      pairingBusy,
    },
    setPairingEnabled,
    setPairingExpiresAt,
    setPairingCodeInput,
    handlePairingSubmit,
  };
}
