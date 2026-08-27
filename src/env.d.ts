interface Env {
  INGEST_HMAC_CURRENT: string;
  RESEARCH_HMAC_CURRENT: string;
  COMPANION_REGISTRY: DurableObjectNamespace<import("./companion-registry").CompanionRegistry>;
}
