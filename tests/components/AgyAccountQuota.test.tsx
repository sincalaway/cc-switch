import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgyAccountQuota } from "@/components/settings/auth/AccountQuota";
import { RefreshAllQuotaButton } from "@/components/settings/auth/RefreshAllQuotaButton";
import {
  agyAuthStatusQuery,
  invalidateAgyLoginCaches,
  useAgyAccountQuota,
} from "@/lib/query/subscription";
import type { SubscriptionQuota } from "@/types/subscription";
import zh from "@/i18n/locales/zh.json";

const mocks = vi.hoisted(() => ({
  getAgyAccountQuota: vi.fn(),
  getAgyAccountLastQuota: vi.fn(),
  getSettings: vi.fn(),
  authGetStatus: vi.fn(),
}));

vi.mock("@/lib/api/subscription", () => ({
  subscriptionApi: {
    getAgyAccountQuota: mocks.getAgyAccountQuota,
    getAgyAccountLastQuota: mocks.getAgyAccountLastQuota,
  },
}));

vi.mock("@/lib/api/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/settings")>()),
  settingsApi: { get: mocks.getSettings },
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  authApi: {
    authGetStatus: mocks.authGetStatus,
  },
  settingsApi: { get: mocks.getSettings },
}));

const i18n = createInstance();
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "zh",
    resources: { zh: { translation: zh } },
    interpolation: { escapeValue: false },
  });
});

function makeQuota(
  overrides: Partial<SubscriptionQuota> = {},
): SubscriptionQuota {
  return {
    tool: "agy",
    credentialStatus: "valid",
    credentialMessage: null,
    success: true,
    tiers: [
      {
        name: "agy_gemini_five_hour",
        utilization: 30,
        resetsAt: null,
      },
    ],
    extraUsage: null,
    error: null,
    queriedAt: Date.now() - 2 * 60 * 60 * 1000,
    ...overrides,
  };
}

const NOT_FOUND_QUOTA: SubscriptionQuota = {
  tool: "agy",
  credentialStatus: "not_found",
  credentialMessage: null,
  success: false,
  tiers: [],
  extraUsage: null,
  error: null,
  queriedAt: null,
};

function newClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryDelay: 0 },
    },
  });
}

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
    </QueryClientProvider>
  );
}

describe("AgyAccountQuota", () => {
  beforeEach(() => {
    mocks.getAgyAccountQuota.mockReset();
    mocks.getAgyAccountLastQuota.mockReset();
    mocks.getSettings.mockReset();
    mocks.authGetStatus.mockReset();
  });

  it("shows stored local snapshot with a disabled refresh button for non-current accounts even in manual-only mode", async () => {
    const user = userEvent.setup();
    mocks.getSettings.mockResolvedValue({ officialQuotaManualOnly: true });
    mocks.getAgyAccountLastQuota.mockResolvedValue(makeQuota());

    render(
      <AgyAccountQuota accountId="b" login="b@example.com" isCurrent={false} />,
      { wrapper: wrapperFor(newClient()) },
    );

    expect(await screen.findByText("剩余 70%")).toBeInTheDocument();
    expect(screen.getByText("2 小时前")).toBeInTheDocument();
    expect(screen.queryByText(zh.quota.manualIdle)).not.toBeInTheDocument();
    expect(mocks.getAgyAccountLastQuota).toHaveBeenCalledWith("b");
    expect(mocks.getAgyAccountQuota).not.toHaveBeenCalled();

    const refreshButton = screen.getByRole("button", {
      name: "刷新 b@example.com 的额度",
    });
    expect(refreshButton).toHaveAttribute("aria-disabled", "true");

    await user.hover(refreshButton);
    const tips = await screen.findAllByText(
      zh.authCenter.agy.quotaRefreshDisabledHint,
    );
    expect(tips.length).toBeGreaterThan(0);

    await user.click(refreshButton);
    expect(mocks.getAgyAccountQuota).not.toHaveBeenCalled();
    expect(mocks.getAgyAccountLastQuota).toHaveBeenCalledTimes(1);
  });

  it("shows the switch-to-check hint without flickering when a non-current account has no local snapshot", async () => {
    const user = userEvent.setup();
    mocks.getSettings.mockResolvedValue({ officialQuotaManualOnly: true });
    mocks.getAgyAccountLastQuota.mockResolvedValue(null);

    render(
      <AgyAccountQuota accountId="b" login="b@example.com" isCurrent={false} />,
      { wrapper: wrapperFor(newClient()) },
    );

    expect(
      await screen.findByText(zh.authCenter.agy.quotaNotCurrent),
    ).toBeInTheDocument();
    expect(screen.queryByText(zh.quota.manualIdle)).not.toBeInTheDocument();
    expect(mocks.getAgyAccountLastQuota).toHaveBeenCalledWith("b");
    expect(mocks.getAgyAccountQuota).not.toHaveBeenCalled();

    const refreshButton = screen.getByRole("button", {
      name: "刷新 b@example.com 的额度",
    });
    expect(refreshButton).toHaveAttribute("aria-disabled", "true");

    // 重复点击置灰的刷新按钮不会卸载整列，也不会触发查询
    await user.click(refreshButton);
    await user.click(refreshButton);
    expect(
      screen.getByText(zh.authCenter.agy.quotaNotCurrent),
    ).toBeInTheDocument();
    expect(mocks.getAgyAccountQuota).not.toHaveBeenCalled();
  });

  it("keeps current account in manual-idle state without auto-reading disk snapshot when manual-only is enabled", async () => {
    mocks.getSettings.mockResolvedValue({ officialQuotaManualOnly: true });
    mocks.getAgyAccountQuota.mockResolvedValue(
      makeQuota({
        tiers: [
          { name: "agy_gemini_five_hour", utilization: 10, resetsAt: null },
        ],
      }),
    );

    render(<AgyAccountQuota accountId="a" login="a@example.com" isCurrent />, {
      wrapper: wrapperFor(newClient()),
    });

    expect(await screen.findByText(zh.quota.manualIdle)).toBeInTheDocument();
    expect(mocks.getAgyAccountQuota).not.toHaveBeenCalled();
    expect(mocks.getAgyAccountLastQuota).not.toHaveBeenCalled();

    const refreshButton = screen.getByRole("button", {
      name: "刷新 a@example.com 的额度",
    });
    expect(refreshButton).toHaveAttribute("aria-disabled", "false");

    fireEvent.click(refreshButton);
    expect(await screen.findByText("剩余 90%")).toBeInTheDocument();
    expect(mocks.getAgyAccountQuota).toHaveBeenCalledWith("a");
  });

  it("recovers to manual-idle instead of hiding the column when a newly current account had cached not_found", async () => {
    mocks.getSettings.mockResolvedValue({ officialQuotaManualOnly: true });
    mocks.authGetStatus.mockResolvedValue({
      provider: "agy_oauth",
      authenticated: true,
      default_account_id: "b",
      accounts: [],
    });
    let resolveQuota!: (quota: SubscriptionQuota) => void;
    mocks.getAgyAccountQuota.mockImplementation(
      () =>
        new Promise<SubscriptionQuota>((resolve) => {
          resolveQuota = resolve;
        }),
    );

    const client = newClient();
    // 模拟之前作为非当前号（例如供应商卡片）在共享缓存里留下 not_found
    client.setQueryData(["agy_oauth", "quota", "b"], NOT_FOUND_QUOTA);
    await invalidateAgyLoginCaches(client);

    render(<AgyAccountQuota accountId="b" login="b@example.com" isCurrent />, {
      wrapper: wrapperFor(client),
    });

    expect(await screen.findByText(zh.quota.manualIdle)).toBeInTheDocument();
    const refreshButton = screen.getByRole("button", {
      name: "刷新 b@example.com 的额度",
    });
    expect(refreshButton).toHaveAttribute("aria-disabled", "false");

    // 点击手动刷新期间显示「正在查询额度…」+ 转圈，不卸载闪烁
    fireEvent.click(refreshButton);
    await waitFor(() =>
      expect(refreshButton).toHaveAttribute("aria-busy", "true"),
    );
    expect(screen.getByText(zh.authCenter.quota.loading)).toBeInTheDocument();

    resolveQuota(
      makeQuota({
        tiers: [
          { name: "agy_gemini_five_hour", utilization: 20, resetsAt: null },
        ],
      }),
    );
    expect(await screen.findByText("剩余 80%")).toBeInTheDocument();
  });

  it("refetches a mounted auto-mode observer with cached not_found instead of detaching it when switching accounts", async () => {
    mocks.getSettings.mockResolvedValue({});
    let switched = false;
    let resolveNextQuota!: (quota: SubscriptionQuota) => void;
    mocks.getAgyAccountQuota.mockImplementation((id: string) => {
      if (switched && id === "b") {
        return new Promise<SubscriptionQuota>((resolve) => {
          resolveNextQuota = resolve;
        });
      }
      return Promise.resolve(NOT_FOUND_QUOTA);
    });
    mocks.authGetStatus
      .mockResolvedValueOnce({
        provider: "agy_oauth",
        authenticated: true,
        default_account_id: "a",
        accounts: [],
      })
      .mockResolvedValueOnce({
        provider: "agy_oauth",
        authenticated: true,
        default_account_id: "b",
        accounts: [],
      });

    function BoundCardObservers() {
      useQuery(agyAuthStatusQuery);
      const b = useAgyAccountQuota("b");
      const c = useAgyAccountQuota("c");
      return (
        <div>
          <span>
            {b.isFetching
              ? "refetching-b"
              : b.data?.success
                ? "loaded-b"
                : `b:${b.data?.credentialStatus ?? "empty"}`}
          </span>
          <span>
            {c.isFetching
              ? "refetching-c"
              : c.data?.success
                ? "loaded-c"
                : `c:${c.data?.credentialStatus ?? "empty"}`}
          </span>
        </div>
      );
    }

    const client = newClient();
    render(<BoundCardObservers />, { wrapper: wrapperFor(client) });

    expect(await screen.findByText("b:not_found")).toBeInTheDocument();
    expect(await screen.findByText("c:not_found")).toBeInTheDocument();
    expect(mocks.getAgyAccountQuota).toHaveBeenCalledTimes(2);
    mocks.getAgyAccountQuota.mockClear();
    switched = true;

    let pendingInvalidation!: Promise<void>;
    act(() => {
      pendingInvalidation = invalidateAgyLoginCaches(client);
    });

    await waitFor(() =>
      expect(mocks.getAgyAccountQuota).toHaveBeenCalledTimes(1),
    );
    expect(mocks.getAgyAccountQuota).toHaveBeenCalledWith("b");
    expect(screen.getByText("refetching-b")).toBeInTheDocument();
    expect(screen.getByText("c:empty")).toBeInTheDocument();

    await act(async () => {
      resolveNextQuota(
        makeQuota({
          tiers: [
            { name: "agy_gemini_five_hour", utilization: 25, resetsAt: null },
          ],
        }),
      );
      await pendingInvalidation;
    });
    expect(await screen.findByText("loaded-b")).toBeInTheDocument();
    expect(mocks.getAgyAccountQuota).toHaveBeenCalledTimes(1);
  });

  it("shows loading state instead of hiding the column in auto mode while refetching after cached not_found is reset", async () => {
    mocks.getSettings.mockResolvedValue({});
    mocks.authGetStatus.mockResolvedValue({
      provider: "agy_oauth",
      authenticated: true,
      default_account_id: "b",
      accounts: [],
    });
    let resolveQuota!: (quota: SubscriptionQuota) => void;
    mocks.getAgyAccountQuota.mockImplementation(
      () =>
        new Promise<SubscriptionQuota>((resolve) => {
          resolveQuota = resolve;
        }),
    );

    const client = newClient();
    client.setQueryData(["agy_oauth", "quota", "b"], NOT_FOUND_QUOTA);
    await invalidateAgyLoginCaches(client);

    render(<AgyAccountQuota accountId="b" login="b@example.com" isCurrent />, {
      wrapper: wrapperFor(client),
    });

    expect(
      await screen.findByText(zh.authCenter.quota.loading),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "刷新 b@example.com 的额度" }),
    ).toHaveAttribute("aria-busy", "true");

    resolveQuota(
      makeQuota({
        tiers: [
          { name: "agy_gemini_five_hour", utilization: 25, resetsAt: null },
        ],
      }),
    );
    expect(await screen.findByText("剩余 75%")).toBeInTheDocument();
  });

  it("does not redundantly re-query the displaced account when switching in auto mode", async () => {
    mocks.getSettings.mockResolvedValue({});
    mocks.getAgyAccountLastQuota.mockResolvedValue(null);
    mocks.getAgyAccountQuota.mockImplementation(async (id: string) =>
      makeQuota({
        tiers: [
          {
            name: "agy_gemini_five_hour",
            utilization: id === "a" ? 10 : 40,
            resetsAt: null,
          },
        ],
      }),
    );
    mocks.authGetStatus
      .mockResolvedValueOnce({
        provider: "agy_oauth",
        authenticated: true,
        default_account_id: "a",
        accounts: [],
      })
      .mockResolvedValueOnce({
        provider: "agy_oauth",
        authenticated: true,
        default_account_id: "b",
        accounts: [],
      });

    function TwoAccounts() {
      const { data } = useQuery(agyAuthStatusQuery);
      if (!data) return null;
      return (
        <>
          <AgyAccountQuota
            accountId="a"
            login="a@example.com"
            isCurrent={data.default_account_id === "a"}
          />
          <AgyAccountQuota
            accountId="b"
            login="b@example.com"
            isCurrent={data.default_account_id === "b"}
          />
        </>
      );
    }

    const client = newClient();
    render(<TwoAccounts />, { wrapper: wrapperFor(client) });

    expect(await screen.findByText("剩余 90%")).toBeInTheDocument();
    expect(mocks.getAgyAccountQuota).toHaveBeenCalledTimes(1);
    expect(mocks.getAgyAccountQuota).toHaveBeenCalledWith("a");

    mocks.getAgyAccountQuota.mockClear();

    await act(async () => {
      await invalidateAgyLoginCaches(client);
    });

    expect(await screen.findByText("剩余 60%")).toBeInTheDocument();
    expect(mocks.getAgyAccountQuota).toHaveBeenCalledTimes(1);
    expect(mocks.getAgyAccountQuota).toHaveBeenCalledWith("b");
  });

  it("renders expired non-current snapshots truthfully without rewriting percentages or showing past countdowns", async () => {
    mocks.getSettings.mockResolvedValue({ officialQuotaManualOnly: true });
    mocks.getAgyAccountLastQuota.mockResolvedValue(
      makeQuota({
        tiers: [
          {
            name: "agy_gemini_five_hour",
            utilization: 85,
            resetsAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
          },
        ],
        queriedAt: Date.now() - 6 * 60 * 60 * 1000,
      }),
    );

    render(
      <AgyAccountQuota accountId="b" login="b@example.com" isCurrent={false} />,
      { wrapper: wrapperFor(newClient()) },
    );

    expect(
      await screen.findByRole("meter", { name: "Gemini 5 小时: 剩余 15%" }),
    ).toBeInTheDocument();
    expect(screen.getByText("6 小时前")).toBeInTheDocument();
    expect(screen.queryByText(/后重置/)).not.toBeInTheDocument();
  });

  it("surfaces refetch errors instead of falling back to manual-idle when cached not_found fails to refresh", async () => {
    mocks.getSettings.mockResolvedValue({ officialQuotaManualOnly: true });
    mocks.authGetStatus.mockResolvedValue({
      provider: "agy_oauth",
      authenticated: true,
      default_account_id: "b",
      accounts: [],
    });
    mocks.getAgyAccountQuota.mockRejectedValue(
      new Error("Antigravity quota query timed out"),
    );

    const client = newClient();
    client.setQueryData(["agy_oauth", "quota", "b"], NOT_FOUND_QUOTA);
    await invalidateAgyLoginCaches(client);

    render(<AgyAccountQuota accountId="b" login="b@example.com" isCurrent />, {
      wrapper: wrapperFor(client),
    });

    expect(await screen.findByText(zh.quota.manualIdle)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "刷新 b@example.com 的额度" }),
    );

    expect(
      await screen.findByText("Antigravity quota query timed out"),
    ).toBeInTheDocument();
    expect(screen.getByText(zh.quota.failed)).toBeInTheDocument();
  });

  it("resets cached not_found without removing the query and refreshes auth status before quota queries in invalidateAgyLoginCaches", async () => {
    const order: string[] = [];
    const client = newClient();
    client.setQueryData(["agy_oauth", "quota", "a"], makeQuota());
    client.setQueryData(["agy_oauth", "quota", "b"], NOT_FOUND_QUOTA);
    client.setQueryData(["agy_oauth", "last_quota", "a"], null);
    client.setQueryData(agyAuthStatusQuery.queryKey, {
      provider: "agy_oauth",
      authenticated: true,
      default_account_id: "a",
      accounts: [],
    });
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "invalidate") {
        order.push(event.query.queryKey.join(":"));
      }
    });

    await invalidateAgyLoginCaches(client);
    unsubscribe();

    expect(client.getQueryData(["agy_oauth", "quota", "b"])).toBeUndefined();
    expect(
      client.getQueryCache().find({ queryKey: ["agy_oauth", "quota", "b"] }),
    ).toBeDefined();
    expect(client.getQueryData(["agy_oauth", "quota", "a"])).toBeDefined();
    expect(
      client.getQueryState(["agy_oauth", "last_quota", "a"])?.isInvalidated,
    ).toBe(true);
    expect(
      client.getQueryState(agyAuthStatusQuery.queryKey)?.isInvalidated,
    ).toBe(true);
    expect(order.indexOf("managed-auth-status:agy_oauth")).toBeLessThan(
      order.indexOf("agy_oauth:quota:a"),
    );
  });

  it("falls back to the switch-to-check hint when a stored non-current snapshot is unsuccessful", async () => {
    mocks.getSettings.mockResolvedValue({ officialQuotaManualOnly: true });
    mocks.getAgyAccountLastQuota.mockResolvedValue({
      ...NOT_FOUND_QUOTA,
      credentialStatus: "valid",
      error: "stale failure",
    });

    render(
      <AgyAccountQuota accountId="b" login="b@example.com" isCurrent={false} />,
      { wrapper: wrapperFor(newClient()) },
    );

    expect(
      await screen.findByText(zh.authCenter.agy.quotaNotCurrent),
    ).toBeInTheDocument();
    expect(screen.queryByText("stale failure")).not.toBeInTheDocument();
  });

  it("switches cleanly from live current row to local snapshot row when another account becomes current", async () => {
    mocks.getSettings.mockResolvedValue({ officialQuotaManualOnly: true });
    const snapshot = makeQuota({
      tiers: [
        { name: "agy_gemini_five_hour", utilization: 15, resetsAt: null },
      ],
    });
    mocks.getAgyAccountQuota.mockResolvedValue(snapshot);
    mocks.getAgyAccountLastQuota.mockResolvedValue(snapshot);

    const client = newClient();
    const { rerender } = render(
      <AgyAccountQuota accountId="a" login="a@example.com" isCurrent />,
      { wrapper: wrapperFor(client) },
    );

    expect(await screen.findByText(zh.quota.manualIdle)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "刷新 a@example.com 的额度" }),
    );
    expect(await screen.findByText("剩余 85%")).toBeInTheDocument();

    rerender(
      <AgyAccountQuota accountId="a" login="a@example.com" isCurrent={false} />,
    );

    expect(await screen.findByText("剩余 85%")).toBeInTheDocument();
    expect(mocks.getAgyAccountLastQuota).toHaveBeenCalledWith("a");
    expect(
      screen.getByRole("button", { name: "刷新 a@example.com 的额度" }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("makes Refresh all skip non-current Antigravity accounts", async () => {
    mocks.getSettings.mockResolvedValue({ officialQuotaManualOnly: true });
    mocks.getAgyAccountLastQuota.mockResolvedValue(null);
    mocks.getAgyAccountQuota.mockResolvedValue(
      makeQuota({
        tiers: [
          { name: "agy_gemini_five_hour", utilization: 40, resetsAt: null },
        ],
      }),
    );

    const client = newClient();
    client.setQueryData(agyAuthStatusQuery.queryKey, {
      provider: "agy_oauth",
      authenticated: true,
      default_account_id: "a",
      accounts: [],
    });

    render(
      <>
        <AgyAccountQuota accountId="a" login="a@example.com" isCurrent />
        <AgyAccountQuota
          accountId="b"
          login="b@example.com"
          isCurrent={false}
        />
        <RefreshAllQuotaButton />
      </>,
      { wrapper: wrapperFor(client) },
    );

    expect(await screen.findByText(zh.quota.manualIdle)).toBeInTheDocument();
    expect(
      await screen.findByText(zh.authCenter.agy.quotaNotCurrent),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: zh.authCenter.quota.refreshAll }),
    );

    expect(await screen.findByText("剩余 60%")).toBeInTheDocument();
    expect(mocks.getAgyAccountQuota).toHaveBeenCalledTimes(1);
    expect(mocks.getAgyAccountQuota).toHaveBeenCalledWith("a");
  });

  it("also skips directly observed non-current agy_oauth quota queries during Refresh all", async () => {
    mocks.getSettings.mockResolvedValue({ officialQuotaManualOnly: true });
    mocks.getAgyAccountQuota.mockResolvedValue(makeQuota());

    const client = newClient();
    client.setQueryData(agyAuthStatusQuery.queryKey, {
      provider: "agy_oauth",
      authenticated: true,
      default_account_id: "a",
      accounts: [],
    });

    function DirectObservers() {
      const a = useAgyAccountQuota("a");
      const b = useAgyAccountQuota("b");
      return (
        <span>
          {a.data?.success ? "a-loaded" : "a-idle"}/
          {b.data?.success ? "b-loaded" : "b-idle"}
        </span>
      );
    }

    render(
      <>
        <DirectObservers />
        <RefreshAllQuotaButton />
      </>,
      { wrapper: wrapperFor(client) },
    );

    expect(await screen.findByText("a-idle/b-idle")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: zh.authCenter.quota.refreshAll }),
    );

    expect(await screen.findByText("a-loaded/b-idle")).toBeInTheDocument();
    expect(mocks.getAgyAccountQuota).toHaveBeenCalledTimes(1);
    expect(mocks.getAgyAccountQuota).toHaveBeenCalledWith("a");
  });
});
