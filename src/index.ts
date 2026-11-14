import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import { getZCodeApiKey, loginZCode, refreshZCodeToken } from "./auth/index.js";
import {
  LINKED_PLAN_API_KEY_MARKER,
  readStoredZCodeCredentials,
  setStoredZCodeCredentials,
} from "./auth/credentials.js";
import {
  acquireCaptchaVerifyParam,
  DEFAULT_ENDPOINT,
  endpointCandidates,
  parseApiKey,
  prewarmConnection,
} from "./client/index.js";
import { getLastDiagnostics, runWithDiagnostics, setLastError } from "./diagnostics/index.js";
import {
  buildModelsForPlan,
  fetchModelCatalog,
  fetchModelIdsForPlan,
  PROVIDER_ID,
  PROVIDER_ID_INDIVIDUAL_PLAN,
  PROVIDER_ID_START_PLAN,
  providerIdForPlan,
  PROVIDER_NAMES,
} from "./models/index.js";
import { detectAccountPlans } from "./plans/index.js";
import { ZCODE_API, streamZCode } from "./stream/index.js";
import { ZCodePlan, ZCodePlanStatus } from "./types/enums.js";
import type { ZCodeAccountPlans, ZCodeParsedApiKey } from "./types/types.js";
import { fetchAccountUsage, formatUsageReport, resolveApiKeyFromContext } from "./usage/index.js";
import { redactSecrets } from "./utils/index.js";

function emitCommandOutput(
  ctx: ExtensionCommandContext,
  text: string,
  type: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, type);
    return;
  }
  if (type === "warning" || type === "error") {
    console.error(text);
  } else {
    console.log(text);
  }
}

let activeExtensionAPI: ExtensionAPI | undefined = undefined;

export async function detectAndRegisterPlans(
  pi: ExtensionAPI,
  credentials: ZCodeParsedApiKey,
): Promise<ZCodeAccountPlans> {
  const credsPayload = credentials
    ? JSON.stringify({
        access: credentials.token,
        businessAccessToken: credentials.businessAccessToken,
        zcodeJwtToken: credentials.zcodeJwtToken,
        providerSource: credentials.providerSource,
      })
    : "";

  const plans = await runWithDiagnostics(() => detectAccountPlans(credsPayload));
  const catalog = await fetchModelCatalog(credentials.zcodeJwtToken);

  const registrations: { plan: ZCodePlan; ids: string[] | undefined }[] = [];

  if (plans.startPlan.status === ZCodePlanStatus.ACTIVE) {
    registrations.push({ plan: ZCodePlan.START_PLAN, ids: plans.startPlan.models });
  }
  if (plans.individualPlan.status === ZCodePlanStatus.ACTIVE) {
    registrations.push({ plan: ZCodePlan.INDIVIDUAL_PLAN, ids: undefined });
  }

  const startPlanModels = [];

  for (const reg of registrations) {
    const ids = await fetchModelIdsForPlan(
      reg.plan,
      credentials
        ? JSON.stringify({
            access: credentials.token,
            providerSource: credentials.providerSource,
          })
        : undefined,
      reg.ids,
    );

    if (!ids.length) {
      continue;
    }

    const models = buildModelsForPlan(ids, catalog);
    const providerId = providerIdForPlan(reg.plan);

    // Register dedicated provider for this plan (e.g. zcode-cloud-start-plan)
    pi.registerProvider(providerId, {
      // An in-memory, non-secret auth marker makes this model selectable in Pi.
      // The stream resolves the base provider OAuth token, never this marker.
      apiKey: LINKED_PLAN_API_KEY_MARKER,
      name: PROVIDER_NAMES[reg.plan],
      baseUrl: DEFAULT_ENDPOINT,
      api: ZCODE_API,
      models,
      streamSimple: streamZCode,
    });

    if (reg.plan === ZCodePlan.START_PLAN) {
      startPlanModels.push(...models);
    }
  }

  // Remove plans whose entitlements disappeared rather than retaining stale models.
  if (plans.startPlan.status !== ZCodePlanStatus.ACTIVE) {
    pi.unregisterProvider(PROVIDER_ID_START_PLAN);
  }
  if (plans.individualPlan.status !== ZCodePlanStatus.ACTIVE) {
    pi.unregisterProvider(PROVIDER_ID_INDIVIDUAL_PLAN);
  }

  // The base OAuth provider only exposes Start Plan models: Individual Plan models
  // have a dedicated provider, and must not accidentally route through Start Plan.
  pi.registerProvider(PROVIDER_ID, {
    name: "ZCode Cloud",
    baseUrl: DEFAULT_ENDPOINT,
    api: ZCODE_API,
    models: startPlanModels,
    oauth: {
      name: "ZCode Cloud",
      login: async (callbacks) => {
        const creds = await loginZCode(callbacks);
        const parsed = parseApiKey(getZCodeApiKey(creds));
        setStoredZCodeCredentials(parsed);
        if (activeExtensionAPI) {
          await registerPlansWithDiagnostics(activeExtensionAPI, parsed);
        }
        return creds;
      },
      refreshToken: refreshZCodeToken,
      getApiKey: getZCodeApiKey,
    },
    streamSimple: streamZCode,
  });

  return plans;
}

async function registerPlansWithDiagnostics(
  pi: ExtensionAPI,
  credentials: ZCodeParsedApiKey,
): Promise<void> {
  try {
    await detectAndRegisterPlans(pi, credentials);
  } catch (error) {
    // Do not turn a successful OAuth login into a failure just because the
    // entitlement catalog cannot be refreshed; expose the error in /doctor.
    setLastError(error);
  }
}

export default async function initZCodeExtension(pi: ExtensionAPI): Promise<void> {
  activeExtensionAPI = pi;

  const [primaryEndpoint] = endpointCandidates();
  if (primaryEndpoint) {
    prewarmConnection(primaryEndpoint);
  }

  registerApiProvider({
    api: ZCODE_API,
    stream: streamZCode,
    streamSimple: streamZCode,
  });

  // Base provider registration
  pi.registerProvider(PROVIDER_ID, {
    name: "ZCode Cloud",
    baseUrl: DEFAULT_ENDPOINT,
    api: ZCODE_API,
    models: [],
    oauth: {
      name: "ZCode Cloud",
      login: async (callbacks) => {
        const creds = await loginZCode(callbacks);
        const parsed = parseApiKey(getZCodeApiKey(creds));
        setStoredZCodeCredentials(parsed);
        await registerPlansWithDiagnostics(pi, parsed);
        return creds;
      },
      refreshToken: refreshZCodeToken,
      getApiKey: getZCodeApiKey,
    },
    streamSimple: streamZCode,
  });

  // If already logged in, register plan providers immediately on startup
  const stored = readStoredZCodeCredentials(true);
  if (stored) {
    await registerPlansWithDiagnostics(pi, stored);
  }

  // Refresh plan registration on session start
  pi.on("session_start", async () => {
    const creds = readStoredZCodeCredentials(true);
    if (creds) {
      await registerPlansWithDiagnostics(pi, creds);
    } else {
      // The plan providers have no independent credentials: hide them on logout.
      pi.unregisterProvider(PROVIDER_ID_START_PLAN);
      pi.unregisterProvider(PROVIDER_ID_INDIVIDUAL_PLAN);
    }
  });

  pi.registerCommand("zcode-cloud.usage", {
    description: "Show detected plans, daily balance, and subscription status",
    handler: async (_args, ctx) => {
      try {
        const apiKey = await resolveApiKeyFromContext(ctx);
        if (!apiKey) {
          emitCommandOutput(ctx, "No ZCode credentials found. Run /login zcode-cloud first.", "warning");
          return;
        }
        if (ctx.hasUI) {
          ctx.ui.notify("Fetching ZCode usage…", "info");
        }
        const creds = readStoredZCodeCredentials(true);
        const plans = creds
          ? await detectAccountPlans(
              JSON.stringify({
                access: creds.token,
                businessAccessToken: creds.businessAccessToken,
                zcodeJwtToken: creds.zcodeJwtToken,
                providerSource: creds.providerSource,
              }),
            )
          : await detectAccountPlans(apiKey);
        const usage = await fetchAccountUsage(apiKey, plans);
        emitCommandOutput(ctx, formatUsageReport(plans, usage));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        emitCommandOutput(ctx, `Failed to fetch ZCode usage: ${msg}`, "warning");
      }
    },
  });

  pi.registerCommand("zcode-cloud.doctor", {
    description: "Show ZCode diagnostics report",
    handler: async (_args, ctx) => {
      const d = getLastDiagnostics();
      const registeredModels = ctx.modelRegistry.getAll();
      const availableModels = ctx.modelRegistry.getAvailable();
      const linkedLogin = Boolean(readStoredZCodeCredentials(true));
      const providerIds = [PROVIDER_ID, PROVIDER_ID_START_PLAN, PROVIDER_ID_INDIVIDUAL_PLAN];
      const lines = [
        "ZCode Cloud Provider Doctor",
        `• OAuth (base): ${linkedLogin ? "stored" : "missing"}`,
        ...providerIds.map((id) => {
          const registered = registeredModels.filter((model) => model.provider === id);
          const available = availableModels.filter((model) => model.provider === id);
          const configured = ctx.modelRegistry.getProviderAuthStatus(id).configured;
          return `• ${id}: registered=${registered.length}, selectable=${available.length}, auth=${configured ? "configured" : "missing"}`;
        }),
        `• providerId: ${PROVIDER_ID}`,
        `• endpoint: ${d.endpoint || "none"}`,
        `• status: ${d.status ?? "none"}`,
        `• model: ${d.resolvedRuntimeModel || "none"}`,
        `• latencyMs: ${d.latencyMs !== undefined ? `${d.latencyMs}ms` : "none"}`,
        `• requestId: ${d.requestId || "none"}`,
        `• error: ${d.error ? redactSecrets(d.error) : "none"}`,
        "• transport: native-streamSimple (SSE)",
        "• commands: /login zcode-cloud, /zcode-cloud.usage, /zcode-cloud.doctor",
      ];
      emitCommandOutput(ctx, lines.join("\n"));
    },
  });

  const OVERFLOW_PATTERN = /context_length_exceeded|maximum context length/i;
  pi.on("message_end", (event, _ctx) => {
    const { message } = event;
    if (message.role !== "assistant") {
      return;
    }
    if (message.stopReason !== "error") {
      return;
    }
    if (
      message.provider !== PROVIDER_ID_START_PLAN &&
      message.provider !== PROVIDER_ID_INDIVIDUAL_PLAN &&
      message.provider !== PROVIDER_ID
    ) {
      return;
    }
    const errorMessage = message.errorMessage ?? "";
    if (errorMessage.includes("context_length_exceeded")) {
      return;
    }
    if (!OVERFLOW_PATTERN.test(errorMessage)) {
      return;
    }
    return {
      message: { ...message, errorMessage: `context_length_exceeded: ${errorMessage}` },
    };
  });
}
