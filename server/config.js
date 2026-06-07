import { z } from "zod";

const boolFromEnv = (value, fallback = false) => {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
};

const schema = z.object({
  appPort: z.coerce.number().int().min(1).max(65535).default(3000),
  zabbixApiUrl: z.string().url().optional(),
  zabbixApiToken: z.string().optional(),
  zabbixUsername: z.string().optional(),
  zabbixPassword: z.string().optional(),
  grafanaEnabled: z.boolean().default(false),
  grafanaUrl: z.string().url().optional(),
  grafanaApiKey: z.string().optional(),
  readOnly: z.boolean().default(false),
  sessionTtlSeconds: z.coerce.number().int().min(60).max(86400).default(900),
  requestTimeoutMs: z.coerce.number().int().min(1000).max(60000).default(12000)
});

export function loadConfig(env = process.env) {
  const parsed = schema.parse({
    appPort: env.APP_PORT,
    zabbixApiUrl: env.ZABBIX_API_URL,
    zabbixApiToken: env.ZABBIX_API_TOKEN || undefined,
    zabbixUsername: env.ZABBIX_USERNAME,
    zabbixPassword: env.ZABBIX_PASSWORD,
    grafanaEnabled: boolFromEnv(env.GRAFANA_ENABLED),
    grafanaUrl: env.GRAFANA_URL || undefined,
    grafanaApiKey: env.GRAFANA_API_KEY || undefined,
    readOnly: boolFromEnv(env.READ_ONLY),
    sessionTtlSeconds: env.SESSION_TTL_SECONDS,
    requestTimeoutMs: env.REQUEST_TIMEOUT_MS
  });

  return {
    ...parsed,
    zabbixTokenAuth: Boolean(parsed.zabbixApiUrl && parsed.zabbixApiToken),
    zabbixConfigured: Boolean(parsed.zabbixApiUrl && (parsed.zabbixApiToken || (parsed.zabbixUsername && parsed.zabbixPassword))),
    grafanaConfigured: Boolean(parsed.grafanaEnabled && parsed.grafanaUrl)
  };
}
