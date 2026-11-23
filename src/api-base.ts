/**
 * Base URL of the Zenrows API (https://api.zenrows.com/v1): scrape, extract and the
 * account details. The Crawl and Extract preparation clients default to it too, so one
 * variable points a deployment at another environment.
 */

export const DEFAULT_API_BASE = "https://api.zenrows.com/v1";
export const API_BASE_ENV = "ZENROWS_API_BASE";

export function apiBase(): string {
  const env = process.env[API_BASE_ENV];
  const base = env && env.trim() ? env.trim() : DEFAULT_API_BASE;
  return base.replace(/\/+$/, "");
}
