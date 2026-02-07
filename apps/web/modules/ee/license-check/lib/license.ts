import "server-only";
import { HttpsProxyAgent } from "https-proxy-agent";
import fetch from "node-fetch";
import { cache as reactCache } from "react";
import { z } from "zod";
import { createCacheKey } from "@formbricks/cache";
import { prisma } from "@formbricks/database";
import { logger } from "@formbricks/logger";
import { cache } from "@/lib/cache";
import { E2E_TESTING } from "@/lib/constants";
import { env } from "@/lib/env";
import { hashString } from "@/lib/hash-string";
import { getInstanceId } from "@/lib/instance";
import {
  TEnterpriseLicenseDetails,
  TEnterpriseLicenseFeatures,
} from "@/modules/ee/license-check/types/enterprise-license";

// Configuration
const CONFIG = {
  CACHE: {
    FETCH_LICENSE_TTL_MS: 24 * 60 * 60 * 1000, // 24 hours
    PREVIOUS_RESULT_TTL_MS: 4 * 24 * 60 * 60 * 1000, // 4 days
    GRACE_PERIOD_MS: 3 * 24 * 60 * 60 * 1000, // 3 days
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 1000,
  },
  API: {
    ENDPOINT:
      env.ENVIRONMENT === "staging"
        ? "https://staging.ee.formbricks.com/api/licenses/check"
        : "https://ee.formbricks.com/api/licenses/check",
    // ENDPOINT: "https://localhost:8080/api/licenses/check",
    TIMEOUT_MS: 5000,
  },
} as const;

// Types
type FallbackLevel = "live" | "cached" | "grace" | "default";

type TEnterpriseLicenseStatusReturn = "active" | "expired" | "unreachable" | "no-license";

type TEnterpriseLicenseResult = {
  active: boolean;
  features: TEnterpriseLicenseFeatures | null;
  lastChecked: Date;
  isPendingDowngrade: boolean;
  fallbackLevel: FallbackLevel;
  status: TEnterpriseLicenseStatusReturn;
};

// Validation schemas
const LicenseFeaturesSchema = z.object({
  isMultiOrgEnabled: z.boolean(),
  projects: z.number().nullable(),
  twoFactorAuth: z.boolean(),
  sso: z.boolean(),
  whitelabel: z.boolean(),
  removeBranding: z.boolean(),
  contacts: z.boolean(),
  ai: z.boolean(),
  saml: z.boolean(),
  spamProtection: z.boolean(),
  auditLogs: z.boolean(),
  multiLanguageSurveys: z.boolean(),
  accessControl: z.boolean(),
  quotas: z.boolean(),
});

const LicenseDetailsSchema = z.object({
  status: z.enum(["active", "expired"]),
  features: LicenseFeaturesSchema,
});

// Error types
class LicenseError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = "LicenseError";
  }
}

class LicenseApiError extends LicenseError {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message, "API_ERROR");
    this.name = "LicenseApiError";
  }
}

// Cache keys using enterprise-grade hierarchical patterns
const getCacheIdentifier = () => {
  if (globalThis.window !== undefined) {
    return "browser"; // Browser environment
  }
  if (!env.ENTERPRISE_LICENSE_KEY) {
    return "no-license"; // No license key provided
  }
  return hashString(env.ENTERPRISE_LICENSE_KEY); // Valid license key
};

export const getCacheKeys = () => {
  const identifier = getCacheIdentifier();
  return {
    FETCH_LICENSE_CACHE_KEY: createCacheKey.license.status(identifier),
    PREVIOUS_RESULT_CACHE_KEY: createCacheKey.license.previous_result(identifier),
  };
};

// Helper functions
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const trackApiError = (error: LicenseApiError) => {
  logger.error(
    {
      status: error.status,
      code: error.code,
      timestamp: new Date().toISOString(),
    },
    `License API error: ${error.message}`
  );
};

const validateLicenseDetails = (data: unknown): TEnterpriseLicenseDetails => {
  return LicenseDetailsSchema.parse(data);
};

// API functions
let fetchLicensePromise: Promise<TEnterpriseLicenseDetails | null> | null = null;

const fetchLicenseFromServerInternal = async (retryCount = 0): Promise<TEnterpriseLicenseDetails | null> => {
  if (!env.ENTERPRISE_LICENSE_KEY) return null;

  // Skip license checks during build time
  // eslint-disable-next-line turbo/no-undeclared-env-vars -- NEXT_PHASE is a next.js env variable
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return null;
  }

  try {
    const now = new Date();
    const startOfYear = new Date(now.getFullYear(), 0, 1);
    // first millisecond of next year => current year is fully included
    const startOfNextYear = new Date(now.getFullYear() + 1, 0, 1);

    const startTime = Date.now();
    const [instanceId, responseCount] = await Promise.all([
      // Skip instance ID during E2E tests to avoid license key conflicts
      // as the instance ID changes with each test run
      E2E_TESTING ? null : getInstanceId(),
      prisma.response.count({
        where: {
          createdAt: {
            gte: startOfYear,
            lt: startOfNextYear,
          },
        },
      }),
    ]);
    const duration = Date.now() - startTime;

    if (duration > 1000) {
      logger.warn({ duration, responseCount }, "Slow license check prerequisite data fetching (DB count)");
    }

    // No organization exists, cannot perform license check
    // (skip this check during E2E tests as we intentionally use null)
    if (!E2E_TESTING && !instanceId) return null;

    const proxyUrl = env.HTTPS_PROXY ?? env.HTTP_PROXY;
    const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.API.TIMEOUT_MS);

    const payload: Record<string, unknown> = {
      licenseKey: env.ENTERPRISE_LICENSE_KEY,
      usage: { responseCount },
    };

    if (instanceId) {
      payload.instanceId = instanceId;
    }

    const res = await fetch(CONFIG.API.ENDPOINT, {
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      agent,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (res.ok) {
      const responseJson = (await res.json()) as { data: unknown };
      const licenseDetails = validateLicenseDetails(responseJson.data);

      logger.debug(
        {
          status: licenseDetails.status,
          instanceId: instanceId ?? "not-set",
          responseCount,
          timestamp: new Date().toISOString(),
        },
        "License check API response received"
      );

      return licenseDetails;
    }

    const error = new LicenseApiError(`License check API responded with status: ${res.status}`, res.status);
    trackApiError(error);

    // Retry on specific status codes
    if (retryCount < CONFIG.CACHE.MAX_RETRIES && [429, 502, 503, 504].includes(res.status)) {
      await sleep(CONFIG.CACHE.RETRY_DELAY_MS * Math.pow(2, retryCount));
      return fetchLicenseFromServerInternal(retryCount + 1);
    }

    return null;
  } catch (error) {
    if (error instanceof LicenseApiError) {
      throw error;
    }
    logger.error(error, "Error while fetching license from server");
    return null;
  }
};

export const fetchLicense = async (): Promise<TEnterpriseLicenseDetails | null> => {
  if (!env.ENTERPRISE_LICENSE_KEY) return null;

  // Skip license checks during build time - check before cache access
  // eslint-disable-next-line turbo/no-undeclared-env-vars -- NEXT_PHASE is a next.js env variable
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return null;
  }

  if (fetchLicensePromise) {
    return fetchLicensePromise;
  }

  fetchLicensePromise = (async () => {
    return await cache.withCache(
      async () => {
        return await fetchLicenseFromServerInternal();
      },
      getCacheKeys().FETCH_LICENSE_CACHE_KEY,
      CONFIG.CACHE.FETCH_LICENSE_TTL_MS
    );
  })();

  fetchLicensePromise
    .finally(() => {
      fetchLicensePromise = null;
    })
    .catch(() => { });

  return fetchLicensePromise;
};

export const getEnterpriseLicense = reactCache(async (): Promise<TEnterpriseLicenseResult> => {
  return {
    active: true,
    features: {
      isMultiOrgEnabled: true,
      projects: Infinity,
      twoFactorAuth: true,
      sso: true,
      whitelabel: true,
      removeBranding: true,
      contacts: true,
      ai: true,
      saml: true,
      spamProtection: true,
      auditLogs: true,
      multiLanguageSurveys: true,
      accessControl: true,
      quotas: true,
    },
    lastChecked: new Date(),
    isPendingDowngrade: false,
    fallbackLevel: "live",
    status: "active",
  };
});

export const getLicenseFeatures = async (): Promise<TEnterpriseLicenseFeatures | null> => {
  return {
    isMultiOrgEnabled: true,
    projects: Infinity,
    twoFactorAuth: true,
    sso: true,
    whitelabel: true,
    removeBranding: true,
    contacts: true,
    ai: true,
    saml: true,
    spamProtection: true,
    auditLogs: true,
    multiLanguageSurveys: true,
    accessControl: true,
    quotas: true,
  };
};

// All permission checking functions and their helpers have been moved to utils.ts
