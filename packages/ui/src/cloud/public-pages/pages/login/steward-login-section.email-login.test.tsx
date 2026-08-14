/** Verifies StewardLoginSection email magic-link companion code through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Email magic-link companion-code login coverage. The Steward HTTP adapter is
 * doubled so these tests can assert the login state machine: code redemption
 * establishes the session, while remote link approval polling only updates UI.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const emailLoginSpies = vi.hoisted(() => ({
  start: vi.fn(),
  verify: vi.fn(),
  poll: vi.fn(),
}));

const sessionSpies = vi.hoisted(() => ({
  sync: vi.fn(),
  recover: vi.fn(),
  hasAuthedCookie: vi.fn(),
}));

const emailCompleteSpies = vi.hoisted(() => ({
  listener: null as
    | null
    | ((message: { email: string; destination: string }) => void),
  unsubscribe: vi.fn(),
}));

vi.mock("./passkey-capability", () => ({
  resolveWebPasskeyCapability: () =>
    Promise.resolve({ usable: false, reason: "native-without-bridge" }),
}));

vi.mock("@stwd/sdk", () => ({
  StewardAuth: class {
    getProviders() {
      return Promise.resolve({
        passkey: false,
        email: true,
        siwe: false,
        siws: false,
        google: false,
        discord: false,
        github: false,
        twitter: false,
        oauth: [],
      });
    }
    getSession() {
      return null;
    }
    refreshSession() {
      return Promise.resolve(null);
    }
  },
}));

vi.mock("../../../shell/steward-url", () => ({
  resolveBrowserStewardApiUrl: () => "https://api.example.test/steward",
}));

vi.mock("../../../shell/steward-config", () => ({
  configuredStewardTenantId: () => "elizacloud",
  DEFAULT_STEWARD_TENANT_ID: "elizacloud",
}));

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? _key,
}));

vi.mock("@elizaos/shared/steward-session-client", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@elizaos/shared/steward-session-client")
  >()),
  hasStewardAuthedCookie: sessionSpies.hasAuthedCookie,
}));

vi.mock("../../lib/steward-email-login", () => ({
  StewardEmailLoginError: class StewardEmailLoginError extends Error {
    status: number;
    code: string | null;
    constructor(message: string, status: number, code: string | null) {
      super(message);
      this.name = "StewardEmailLoginError";
      this.status = status;
      this.code = code;
    }
  },
  startStewardEmailLogin: emailLoginSpies.start,
  verifyStewardEmailSignInCode: emailLoginSpies.verify,
  pollStewardEmailSignInStatus: emailLoginSpies.poll,
}));

vi.mock("../../lib/steward-session", () => ({
  hasStewardOAuthCallbackInUrl: () => false,
  consumeStewardCodeFromQuery: () => null,
  consumeStewardTokensFromHash: () => null,
  exchangeStewardCodeViaApi: vi.fn(),
  recoverStewardSessionViaCookie: sessionSpies.recover,
  refreshStewardSessionViaCookie: vi.fn(),
  syncStewardSessionCookie: sessionSpies.sync,
}));

vi.mock("../../lib/steward-email-login-complete", () => ({
  subscribeStewardEmailLoginComplete: vi.fn(
    (
      _email: string,
      listener: (message: { email: string; destination: string }) => void,
    ) => {
      emailCompleteSpies.listener = listener;
      return emailCompleteSpies.unsubscribe;
    },
  ),
}));

vi.mock("../../lib/login-return-to", () => ({
  resolveLoginReturnTo: () => "/cloud",
  consumePendingOAuthReturnTo: () => null,
  storePendingOAuthReturnTo: () => undefined,
}));

import StewardLoginSection from "./steward-login-section";

function renderSection(initialEntry = "/login") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <StewardLoginSection />
    </MemoryRouter>,
  );
}

async function startEmailLogin() {
  const input = await screen.findByPlaceholderText("you@example.com");
  fireEvent.change(input, { target: { value: "person@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: /Magic Link/i }));
  await screen.findByLabelText("Six-digit code");
}

describe("StewardLoginSection email magic-link companion code", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    emailLoginSpies.start.mockResolvedValue({
      expiresAt: Date.now() + 600_000,
      challengeId: "challenge-1",
      pollSecret: "poll-secret",
    });
    emailLoginSpies.verify.mockResolvedValue({
      token: "session-token",
      refreshToken: "refresh-token",
    });
    emailLoginSpies.poll.mockResolvedValue("pending");
    sessionSpies.sync.mockResolvedValue(undefined);
    sessionSpies.recover.mockResolvedValue({ ok: true });
    sessionSpies.hasAuthedCookie.mockReturnValue(false);
    emailCompleteSpies.listener = null;
    emailCompleteSpies.unsubscribe.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("redeems only six digits and establishes the session from the verify response", async () => {
    renderSection();
    await startEmailLogin();

    const codeInput = screen.getByLabelText("Six-digit code");
    fireEvent.change(codeInput, { target: { value: "12a345678" } });
    expect((codeInput as HTMLInputElement).value).toBe("123456");
    fireEvent.click(screen.getByRole("button", { name: /Verify code/i }));

    await waitFor(() =>
      expect(emailLoginSpies.verify).toHaveBeenCalledWith(
        {
          baseUrl: "https://api.example.test/steward",
          tenantId: "elizacloud",
        },
        "person@example.com",
        "123456",
      ),
    );
    await waitFor(() =>
      expect(sessionSpies.sync).toHaveBeenCalledWith(
        "session-token",
        "refresh-token",
      ),
    );
  });

  it("waits for the shared cookie before recovering a consumed link", async () => {
    emailLoginSpies.poll.mockResolvedValue("consumed");
    sessionSpies.hasAuthedCookie.mockReturnValue(false);
    renderSection();
    await startEmailLogin();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(sessionSpies.recover).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Six-digit code")).toBeTruthy();

    sessionSpies.hasAuthedCookie.mockReturnValue(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(await screen.findByText("Signed in")).toBeTruthy();
    expect(
      screen.getByText(
        "Sign-in finished in another tab. You can continue here or close this tab.",
      ),
    ).toBeTruthy();
    expect(sessionSpies.recover).toHaveBeenCalledOnce();
    expect(sessionSpies.sync).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Six-digit code")).toBeNull();
  });

  it("bounds consumed-link cookie waiting and keeps resend recovery visible", async () => {
    emailLoginSpies.poll.mockResolvedValue("consumed");
    sessionSpies.hasAuthedCookie.mockReturnValue(false);
    renderSection();
    await startEmailLogin();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(13_000);
    });

    expect(await screen.findByText("Link approved")).toBeTruthy();
    expect(
      screen.getByText(
        "The link was used, but this tab could not restore the shared session. Continue in the tab that opened the link or request a fresh email.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Resend/i })).toBeTruthy();
    expect(sessionSpies.recover).not.toHaveBeenCalled();
  });

  it("dismisses the live waiting form when the callback succeeds in another tab", async () => {
    renderSection();
    await startEmailLogin();

    await waitFor(() => expect(emailCompleteSpies.listener).not.toBeNull());
    sessionSpies.hasAuthedCookie.mockReturnValue(true);
    act(() => {
      emailCompleteSpies.listener?.({
        email: "person@example.com",
        destination: "/get-started",
      });
    });

    expect(await screen.findByText("Signed in")).toBeTruthy();
    expect(
      screen.getByText(
        "Sign-in finished in another tab. You can continue here or close this tab.",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Six-digit code")).toBeNull();
    expect(screen.queryByRole("button", { name: /Resend/i })).toBeNull();
    expect(sessionSpies.recover).toHaveBeenCalledOnce();
    expect(sessionSpies.sync).not.toHaveBeenCalled();
  });

  it("does not recover an advisory completion signal before its cookie is readable", async () => {
    sessionSpies.hasAuthedCookie.mockReturnValue(false);
    renderSection();
    await startEmailLogin();

    await waitFor(() => expect(emailCompleteSpies.listener).not.toBeNull());
    act(() => {
      emailCompleteSpies.listener?.({
        email: "person@example.com",
        destination: "/get-started",
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(sessionSpies.recover).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Six-digit code")).toBeTruthy();

    sessionSpies.hasAuthedCookie.mockReturnValue(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(await screen.findByText("Signed in")).toBeTruthy();
    expect(sessionSpies.recover).toHaveBeenCalledOnce();
  });

  it("shows expired and replay guidance for a rejected code", async () => {
    const { StewardEmailLoginError } = await import(
      "../../lib/steward-email-login"
    );
    emailLoginSpies.verify.mockRejectedValue(
      new StewardEmailLoginError("already used", 410, "challenge_consumed"),
    );
    renderSection();
    await startEmailLogin();

    fireEvent.change(screen.getByLabelText("Six-digit code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Verify code/i }));

    expect(
      await screen.findByText(
        "That sign-in email expired or was already used. Request a new email.",
      ),
    ).toBeTruthy();
    expect(sessionSpies.sync).not.toHaveBeenCalled();
  });

  it("renders locked and expired polling states", async () => {
    emailLoginSpies.poll.mockResolvedValueOnce("locked");
    renderSection();
    await startEmailLogin();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(await screen.findByText("Too many attempts")).toBeTruthy();
    expect(sessionSpies.sync).not.toHaveBeenCalled();

    cleanup();
    vi.clearAllMocks();
    emailLoginSpies.start.mockResolvedValue({
      expiresAt: Date.now() + 600_000,
      challengeId: "challenge-2",
      pollSecret: "poll-secret-2",
    });
    emailLoginSpies.poll.mockResolvedValueOnce("expired");
    sessionSpies.sync.mockResolvedValue(undefined);

    renderSection();
    await startEmailLogin();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(await screen.findByText("Email expired")).toBeTruthy();
    expect(sessionSpies.sync).not.toHaveBeenCalled();
  });
});
